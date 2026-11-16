import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourcePositionIndex } from '../../packages/shared/src/script/script-source-position-index.js'
import { validateSourceKnowledge, knowledgeContext, sourceKnowledgeSchema } from '../src/modules/script/script-source-knowledge.js'
import { planTimelineLocalRepair, validateTimelineScope } from '../src/modules/script/script-source-timeline-scope.js'

test('explicit markdown episode index preserves prefix, parents, offsets, duplicate uncertainty and unmarked novels', () => {
  const text = '## 世界规则\n不得改命。\n### 【第一篇章（第1–60集）】\n' + Array.from({ length: 60 }, (_, i) => `- **第${i + 1}集：故事${i + 1}**\n  情节：调查。\n`).join('')
  const index = sourcePositionIndex(text)
  assert.equal(index.status, 'explicit')
  assert.deepEqual(index.episodes.map(x => x.episode_number), Array.from({ length: 60 }, (_, i) => i + 1))
  for (const entry of index.entries) assert.ok(text.slice(entry.offset, entry.offset + entry.length).includes(entry.heading))
  assert.ok(index.entries.some(x => x.kind === 'section' && x.heading.includes('世界规则')))
  assert.ok(index.episodes.every(x => x.parent_id !== null))
  assert.equal(sourcePositionIndex('第1章 前言\n叙事。').status, 'unmarked')
  const duplicate = sourcePositionIndex('# 第1集 开端\n甲。\n# 第1集 续篇\n乙。')
  assert.equal(duplicate.status, 'ambiguous'); assert.ok(duplicate.episodes.every(x => x.ambiguous))
})

test('sparse claims retain speaker, inference, plans and delayed revelation; coordinates do not certify semantics', () => {
  const units = [{ id: 0, offset: 0, text: '林舟怀疑老陈偷锣。' }, { id: 1, offset: 10, text: '老陈否认。' }, { id: 2, offset: 15, text: '后来证明另有其人。' }]
  const claims = [{ category: 'causality', statement: '老陈偷锣', kind: 'inference', holder: '林舟', status: 'unconfirmed', at_unit_id: 0, unit_ids: [0], updates: [{ status: 'refuted', at_unit_id: 2, unit_ids: [2] }] }]
  const checked = validateSourceKnowledge(claims, units, { offset: 0, length: 30 })
  assert.equal(checked![0]!.status, 'unconfirmed'); assert.equal(checked![0]!.updates![0]!.status, 'refuted')
  assert.throws(() => validateSourceKnowledge([{ ...claims[0], unit_ids: [999] }], units, { offset: 0, length: 30 }), /unit/)
  assert.throws(() => sourceKnowledgeSchema.parse([{ ...claims[0], kind: 'certain_guess' }]))
  const legacy = knowledgeContext([{ offset: 0, length: 30 }], units)
  assert.equal(legacy.coverage, 'unannotated'); assert.equal(legacy.semantic_verification, 'not_performed')
  const context = knowledgeContext([{ offset: 0, length: 30, knowledge: checked }], units)
  assert.equal(context.claims[0]!.kind, 'inference')
  assert.match(context.instructions, /计划不等于已经发生/)
})

test('timeline primary ownership permits cross chapter evidence, patch binds frozen item hashes and cannot delete unmatched facts', () => {
  const task = { key: 'timeline:0', section_ids: [0], scope_version: 2 as const }
  const valid = { summary: '先见到失物，后来确认归属', primary_section_id: 0, section_ids: [0, 1] }
  assert.doesNotThrow(() => validateTimelineScope(task, [valid], 2))
  const invalid = { summary: '另一章的独立事件', primary_section_id: 1, section_ids: [1] }
  assert.throws(() => validateTimelineScope(task, [invalid], 2), /primary_section_id/)
  const candidate = { covered_section_ids: [0], timeline: [valid, invalid] }
  const plan = planTimelineLocalRepair(candidate, task, 2)!
  assert.ok(plan); assert.match(plan.prompt, /candidate_hash/)
  assert.doesNotMatch(plan.prompt, /先见到失物/)
  assert.throws(() => plan.apply({ repairs: {} }))
  const parsed = JSON.parse(plan.prompt.slice(plan.prompt.indexOf('【局部时间线资料】\n') + '【局部时间线资料】\n'.length))
  const key = parsed.targets[0].id
  const merged = plan.apply({ candidate_hash: parsed.candidate_hash, repairs: { [key]: { ...invalid, primary_section_id: 0, section_ids: [0, 1] } } }) as typeof candidate
  assert.deepEqual(merged.timeline[0], valid); assert.equal(merged.timeline.length, 2)
  assert.throws(() => plan.apply({ candidate_hash: 'wrong', repairs: { [key]: valid } }))
})
