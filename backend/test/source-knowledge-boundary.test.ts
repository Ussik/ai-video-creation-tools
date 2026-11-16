import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessSourceKnowledge, validateSourceKnowledge, knowledgeContext, knowledgeInstructions } from '../src/modules/script/script-source-knowledge.js'
import { resolveSourceSections, scriptSourcePassages, validateSourceCoverage } from '../src/modules/script/script-source-map.js'

const content = '# 规则\n铜锣需要持印。\n且每夜只能一次。\n# 第1集\n主角找到遗物。\n# 第60集\n后来揭示遗物身份。'
const passages = scriptSourcePassages(content), units = passages.flatMap(p => p.units)
const unit = (text: string) => units.find(u => u.text.includes(text))!.id
const claim = (at: number, refs: number[]) => ({ category: 'world_rule' as const, statement: '铜锣需要持印且每夜只能一次。', kind: 'fact' as const,
  holder: null, status: 'confirmed' as const, at_unit_id: at, unit_ids: refs })
const first = unit('铜锣需要持印'), next = unit('且每夜'), later = unit('后来揭示')
const range = { offset: 0, length: content.length }

test('multi-sentence disclosure stays pending without moving its coordinate, while genuine later knowledge remains excluded', () => {
  const contiguous = claim(first, [first, next]), future = claim(first, [first, later]), original = structuredClone([contiguous, future])
  const result = assessSourceKnowledge(original, units, range)
  assert.equal(result.accepted.length, 0)
  assert.deepEqual(result.pending.map(x => x.code), ['evidence_span_unresolved', 'later_disclosure_evidence'])
  assert.deepEqual(result.pending.map(x => x.candidate), original)
  assert.deepEqual(original, [contiguous, future])
  assert.throws(() => validateSourceKnowledge([future], units, range), /晚于/)
  // Explicitly source-established completion can cite prior parts; no automatic max(ID) rewrite.
  const completed = claim(next, [first, next])
  assert.equal(assessSourceKnowledge([completed], units, range).accepted.length, 1)
})

test('valid directory, characters, events and every raw annotation survive an auxiliary failure', () => {
  const valid = claim(first, [first]), ambiguous = claim(first, [first, next]), future = claim(first, [first, later])
  const planned = { ...claim(unit('主角找到遗物'), [unit('主角找到遗物')]), kind: 'plan' as const, status: 'unconfirmed' as const, statement: '主角找到父母遗物。' }
  const original = { sections: [{ start_unit: 0, title: '原稿', episode_number: null, summary: '世界规则与剧情。', continues_previous: false,
    open_threads: [], characters: [], events: [{ summary: '主角找到遗物。', evidence: { unit_id: unit('主角找到遗物') } }], knowledge: [valid, ambiguous, future, planned] }] }
  const before = structuredClone(original), resolved = resolveSourceSections(original, passages)
  assert.deepEqual(original, before); assert.deepEqual(resolved.problems, [])
  validateSourceCoverage(content, resolved.sections)
  const section = resolved.sections[0]!
  assert.deepEqual(section.knowledge, [valid]); assert.equal(section.knowledge_pending!.length, 3)
  assert.deepEqual(section.knowledge_pending!.map(x => x.candidate), [ambiguous, future, planned])
  assert.equal(section.events[0]!.summary, '主角找到遗物。')
  const context = knowledgeContext(resolved.sections, units)
  assert.equal(context.claims.length, 1); assert.equal(context.pending.length, 3)
  assert.ok(context.pending.every(x => x.usage === 'not_accepted_do_not_use_as_fact'))
  assert.equal(context.annotation_status, 'needs_attention')
  const legacy = knowledgeContext([{ ...section, knowledge: [future], knowledge_pending: undefined }], units)
  assert.equal(legacy.claims.length, 0); assert.equal(legacy.pending.length, 1)
})

test('auxiliary quarantine cannot release invalid event references, broken map coverage or unknown source units', () => {
  const bad = claim(first, [99999])
  assert.equal(assessSourceKnowledge([bad], units, range).pending[0]!.code, 'invalid_coordinate')
  const value = { sections: [{ start_unit: 0, title: '原稿', episode_number: null, summary: '定位。', continues_previous: false,
    open_threads: [], characters: [], events: [{ summary: '不存在的事件证据。', evidence: { unit_id: 99999 } }], knowledge: [bad] }] }
  const resolved = resolveSourceSections(value, passages)
  assert.equal(resolved.sections[0]!.knowledge_pending!.length, 1)
  assert.equal(resolved.problems.length, 1)
  assert.throws(() => validateSourceCoverage(content, resolved.sections), /证据/)
  const empty = { ...resolved.sections[0]!, events: [], length: 1 }
  assert.throws(() => validateSourceCoverage(content, [empty]), /未分析/)
})

test('narrator events stay facts; author synopsis is not a character plan or a character knowledge clock', () => {
  const at = unit('主角找到遗物')
  const fact = { ...claim(at, [at]), statement: '主角找到父母遗物。' }
  assert.equal(assessSourceKnowledge([fact], units, range).accepted[0]!.kind, 'fact')
  const plan = { ...fact, kind: 'plan' as const, status: 'unconfirmed' as const }
  assert.equal(assessSourceKnowledge([plan], units, range).pending[0]!.code, 'unattributed_plan')
  assert.equal(assessSourceKnowledge([{ ...plan, holder: '主角' }], units, range).accepted[0]!.kind, 'plan')
  assert.match(knowledgeInstructions, /作者在分集梗概明确叙述/)
  assert.match(knowledgeInstructions, /不是句子开头、剧情发生时间或角色知情时点/)
})
