import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addedReferenceCharacterIssue, compileRefinementReferences, referenceIdentityAssignmentIssue, requestedReferenceCharacters, type RefinementReferenceIdentity } from '../src/modules/skills/prompt-refinement-references.js'

const identities: RefinementReferenceIdentity[] = [
  { asset_id: 'original', image_number: 1, profiles: [{ profile_id: 'role-a', kind: 'character', name: '沈行', variant: '雨衣' }] },
  { asset_id: 'new-role', image_number: 2, profiles: [{ profile_id: 'role-b', kind: 'character', name: '温宁', variant: '便服' }] },
]

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

test('only explicitly requested character additions require a scene depiction and matching image', () => {
  const added = requestedReferenceCharacters('将参考图2作为温宁的人物参考，加入这个新角色，保留沈行。', '沈行站在前景。', identities)
  assert.deepEqual(added.map(value => value.name), ['温宁'])
  assert.match(addedReferenceCharacterIssue('沈行站在左侧；参考图2只用于温宁的身份、面部和服装。', added)!, /位置或动作/)
  assert.match(addedReferenceCharacterIssue('温宁不出现在画面右侧，参考图2作为身份参考。', added)!, /位置或动作/)
  assert.match(addedReferenceCharacterIssue('温宁站在画面右侧，外观参考图1。', added)!, /关联/)
  assert.equal(addedReferenceCharacterIssue('温宁站在画面右侧注视沈行，人物外观依据参考图2。', added), null)
  assert.deepEqual(requestedReferenceCharacters('加强光线，保留温宁的衣服。', '沈行站在前景。', identities), [])
  assert.deepEqual(requestedReferenceCharacters('不要加入温宁。', '沈行站在前景。', identities), [])
  assert.deepEqual(requestedReferenceCharacters('将新加入的参考图2作为温宁的人物外观参考。', '沈行站在前景。', identities), [])
  assert.deepEqual(requestedReferenceCharacters('新增温宁的参考图。', '沈行站在前景。', identities), [])
  assert.equal(requestedReferenceCharacters('加入参考图2中的人物。', '沈行站在前景。', identities)[0]?.name, '温宁')
})

test('a previously saved purpose-only mention still needs the explicitly selected character to enter the scene', () => {
  const adjustment = '将参考图2作为温宁的人物参考，加入这个新角色，保留沈行。'
  const purposeOnly = '沈行站在前景；参考图2只用于温宁的身份、面部和服装。'
  assert.deepEqual(requestedReferenceCharacters(adjustment, purposeOnly, identities).map(value => value.name), ['温宁'])
  assert.deepEqual(requestedReferenceCharacters(adjustment, '沈行站在前景。温宁站在画面右侧，外观参考图2。', identities), [])
  assert.deepEqual(requestedReferenceCharacters(adjustment, '沈行站在前景；温宁不出现在画面右侧，参考图2仅作人物参考。', identities).map(value => value.name), ['温宁'])
})

test('known character identities cannot silently swap while composition references remain valid', () => {
  assert.match(referenceIdentityAssignmentIssue('将参考图1作为温宁的人物参考。', identities)!, /图片身份对应错误/)
  assert.match(referenceIdentityAssignmentIssue('温宁的人物外观参考图1。', identities)!, /图片身份对应错误/)
  assert.equal(referenceIdentityAssignmentIssue('将参考图2作为温宁的人物参考。', identities), null)
  assert.equal(referenceIdentityAssignmentIssue('温宁位于右侧，参考图1的构图和光线。', identities), null)
  assert.equal(referenceIdentityAssignmentIssue('参考图1不用于温宁的人物身份。', identities), null)
  assert.equal(referenceIdentityAssignmentIssue('温宁的人物身份不参考图1。', identities), null)
})
