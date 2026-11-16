import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSourceUncertainties } from '../src/modules/script/script-source-uncertainty-output.js'
import { sourceStorySchema } from '../src/modules/script/script-source-story-parts.js'
const schema = sourceStorySchema.pick({ uncertainties: true })
const alternate = () => ({ summary: '谁仍在水牢中', explanation: '前文多人被封印，后文仅说明父母的状态，其他成员下落未知。', source_section_ids: [0, 1], current_state_section_ids: [3, 1] })
const normalize = (item: unknown, requested = [0, 1]) => normalizeSourceUncertainties({ uncertainties: [item] }, requested, 4) as { uncertainties: any[] }
test('the exact alternate envelope keeps every string, ID and evidence role under the unchanged strict contract', () => {
  const item = alternate(), copy = structuredClone(item), value = schema.parse(normalize(item)).uncertainties[0]!
  assert.equal(value.description, `${item.summary}\n${item.explanation}\n来源章节ID：0、1；当前状态章节ID：3、1`)
  assert.deepEqual(value.section_ids, [0, 1, 3]); assert.deepEqual(item, copy)
})
test('canonical fields are unchanged and compatibility does not apply to other envelopes', () => {
  const canonical = { description: '原样保留', section_ids: [1] }
  assert.deepEqual(normalize(canonical).uncertainties[0], canonical)
  for (const item of [{ ...alternate(), description: '冲突字段' }, { ...alternate(), note: '未知事实' }, { ...alternate(), question: '并非已知别名' }]) {
    assert.equal(schema.safeParse(normalize(item)).success, false)
    assert.deepEqual(normalize(item).uncertainties[0], item)
  }
})
test('current-state references cannot impersonate in-range source evidence', () => {
  const item = { ...alternate(), source_section_ids: [3], current_state_section_ids: [0] }
  assert.equal(schema.safeParse(normalize(item)).success, false)
})
test('empty, duplicate, nonexistent and malformed evidence stays rejected', () => {
  for (const patch of [{ source_section_ids: [] }, { source_section_ids: [0, 0] }, { source_section_ids: [0, 4] },
    { current_state_section_ids: [-1] }, { current_state_section_ids: [3, 3] }, { current_state_section_ids: ['1'] },
    { summary: '' }, { explanation: null }]) assert.equal(schema.safeParse(normalize({ ...alternate(), ...patch })).success, false)
})
test('long explanations are never truncated to make the contract pass', () => {
  const item = { ...alternate(), explanation: '完整事实'.repeat(200) }
  const value = normalize(item)
  assert.ok(value.uncertainties[0].description.includes(item.explanation)); assert.equal(schema.safeParse(value).success, false)
})
