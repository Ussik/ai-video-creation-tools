import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileRefinementReferences } from '../src/modules/skills/prompt-refinement-references.js'

test('adjustment references follow asset identity after scope and replacement changes, without selecting extra images', () => {
  assert.equal(compileRefinementReferences('加入[[ref:replacement]]中的人物。', ['original', 'replacement']), '加入参考图 2中的人物。')
  assert.equal(compileRefinementReferences('使用参考图2。', ['replacement'], {
    suppliedReferenceIds: ['removed', 'old'], overrides: { old: 'replacement' },
  }), '使用参考图 1。')
  assert.throws(() => compileRefinementReferences('使用[[ref:unknown]]。', ['original']), /已断开/)
  assert.throws(() => compileRefinementReferences('使用参考图3。', ['original']), /不在实际参考列表/)
  assert.throws(() => compileRefinementReferences('使用[[ref:bad id]]。', ['original']), /无效/)
  assert.throws(() => compileRefinementReferences('使用[[ref:old]]。', ['original'], { overrides: { old: null } }), /已断开/)
})


test('reference refinement resolves full replacement chains before checking current selected identity', () => {
  const options = { suppliedReferenceIds: ['old'], overrides: { old: 'middle', middle: 'replacement' } }
  assert.equal(compileRefinementReferences('采用[[ref:old]]中的身份。', ['replacement'], options), '采用参考图 1中的身份。')
  assert.equal(compileRefinementReferences('采用参考图1中的身份。', ['replacement'], options), '采用参考图 1中的身份。')
  assert.equal(compileRefinementReferences('采用[[ref:old]]中的身份。', ['other', 'replacement'], { ...options, referenceLabel: '图片' }), '采用图片 2中的身份。')
  assert.throws(() => compileRefinementReferences('采用[[ref:old]]。', ['other'], options), /已断开|未在当前模式生效/)
  assert.throws(() => compileRefinementReferences('采用[[ref:old]]。', ['replacement'], { overrides: { old: 'middle', middle: null } }), /已断开/)
  assert.throws(() => compileRefinementReferences('采用[[ref:old]]。', ['replacement'], { overrides: { old: 'middle', middle: 'old' } }), /循环/)
  assert.throws(() => compileRefinementReferences('采用[[ref:old]]。', ['replacement'], { overrides: { old: 'middle', middle: 'new-unselected' } }), /已断开|未在当前模式生效/)
})
