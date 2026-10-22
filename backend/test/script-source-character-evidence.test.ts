import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { createSourceCharacterEvidence } from '../src/modules/script/script-source-character-evidence.js'

function fixture(entries: Array<{ title: string; text: string; names?: string[] }>) {
  let content = ''
  const sections: ScriptSourceSection[] = entries.map(entry => {
    const offset = content.length
    content += entry.text
    return {
      offset, length: entry.text.length, title: entry.title, episode_number: null, summary: '', events: [],
      characters: (entry.names || []).map(name => ({ name, description: '', evidence: { offset, quote: entry.text } })),
    }
  })
  const state: Pick<ScriptSourceAnalysis, 'sections'> = { sections }
  return { state, source: { content }, evidence: createSourceCharacterEvidence(state, { content }) }
}

test('a known name remains supported by cited original text when the directory records it only in another chapter', () => {
  const { evidence } = fixture([
    { title: '第一集', text: '赵缜：我来带路。', names: ['赵师傅', '赵缜'] },
    { title: '第二集', text: '程晏：赵师傅，左轮给我。', names: ['程晏'] },
  ])
  assert.deepEqual(evidence.sectionsFor('赵师傅'), [0, 1])
  assert.equal(evidence.supports('赵师傅', [1]), true)
})

test('original text supports a name omitted from every directory entry', () => {
  const { evidence } = fixture([
    { title: '前章', text: '程晏检查轮轴。', names: ['程晏'] },
    { title: '后章', text: '赵师傅：把工具递给我。' },
  ])
  assert.deepEqual(evidence.sectionsFor('赵师傅'), [1])
  assert.equal(evidence.supports('赵师傅', [1]), true)
})

test('a legal directory association remains valid even when the section body uses a different address', () => {
  const { evidence } = fixture([
    { title: '维修棚', text: '师傅转过身，示意众人离开。', names: ['赵缜'] },
  ])
  assert.equal(evidence.supports('赵缜', [0]), true)
  assert.deepEqual(evidence.sectionsFor('赵缜'), [0])
})

test('wrong citations fail and diagnostics identify available evidence without treating missing citations as invention', () => {
  const { evidence } = fixture([
    { title: '轮轴交接', text: '程晏：赵师傅，左轮给我。' },
    { title: '夜间医院', text: '闻溪等待检查结果。', names: ['闻溪'] },
    { title: '独立回路', text: '程晏：赵师傅，哪条是原本的独立回路？' },
  ])
  assert.equal(evidence.supports('赵师傅', [1]), false)
  const issue = evidence.issue('characters:2', '赵缜', '赵师傅', [1])
  assert.deepEqual(issue.details, {
    task_key: 'characters:2', character_name: '赵缜', name: '赵师傅', section_ids: [1], evidence_section_ids: [0, 2],
  })
  for (const expected of ['characters:2', '赵缜', '赵师傅', '夜间医院', '轮轴交接', '独立回路']) {
    assert.ok(issue.message.includes(expected), `missing diagnostic context: ${expected}`)
  }
  assert.doesNotMatch(issue.message, /凭空|编造|虚构/)
})

test('a name with no directory or original-text evidence reports an empty evidence location list', () => {
  const { evidence } = fixture([{ title: '开篇', text: '程晏进入维修棚。', names: ['程晏'] }])
  assert.equal(evidence.supports('凭空新增的人名', [0]), false)
  assert.deepEqual(evidence.sectionsFor('凭空新增的人名'), [])
  const issue = evidence.issue('characters:0', '程晏', '凭空新增的人名', [0])
  assert.deepEqual(issue.details.evidence_section_ids, [])
  assert.match(issue.message, /未找到|没有找到|未检出|未发现|无可核验|没有可核验/)
})

test('NFKC normalization supports matching both directory names and original-text names', () => {
  const { evidence } = fixture([
    { title: '目录称呼', text: '技师整理仪器。', names: ['Ａｌｉｃｅ'] },
    { title: '原文称呼', text: 'Ａｌｉｃｅ：先断电。' },
  ])
  assert.deepEqual(evidence.sectionsFor('Alice'), [0, 1])
  assert.deepEqual(evidence.sectionsFor('  Ａｌｉｃｅ  '), [0, 1])
  assert.equal(evidence.supports('Alice', [0]), true)
  assert.equal(evidence.supports('Ａｌｉｃｅ', [1]), true)
})

test('invalid chapter IDs and empty references cannot establish evidence', () => {
  const { evidence } = fixture([{ title: '开篇', text: '赵师傅进入维修棚。' }])
  for (const sectionIds of [[], [-1], [1], [999], [0.5], [Number.NaN]]) {
    assert.equal(evidence.supports('赵师傅', sectionIds), false, `unexpected support for ${JSON.stringify(sectionIds)}`)
  }
})

test('every alias must have its own cited evidence rather than inheriting support from the canonical name', () => {
  const { evidence } = fixture([
    { title: '正式称呼', text: '赵缜推开维修棚。', names: ['赵缜'] },
    { title: '口头称呼', text: '程晏：赵师傅，哪条是独立回路？' },
  ])
  assert.equal(evidence.supports('赵缜', [0]), true)
  assert.equal(evidence.supports('赵师傅', [0]), false)
  assert.equal(evidence.supports('赵师傅', [0, 1]), true)
  assert.equal(evidence.supports('老赵头', [0, 1]), false)
})

test('evidence indexing is isolated by name and cannot make another character pass', () => {
  const { evidence } = fixture([
    { title: '程晏行动', text: '程晏进入医院。', names: ['程晏'] },
    { title: '闻溪行动', text: '闻溪离开医院。', names: ['闻溪'] },
  ])
  assert.deepEqual(evidence.sectionsFor('程晏'), [0])
  assert.equal(evidence.supports('闻溪', [0]), false)
  assert.deepEqual(evidence.sectionsFor('闻溪'), [1])
  assert.equal(evidence.supports('程晏', [1]), false)
  assert.deepEqual(evidence.sectionsFor('不存在的人'), [])
})

test('matches must occur inside a real section and empty normalized names never count as evidence', () => {
  const { evidence } = fixture([
    { title: '前章', text: '信上只留下赵' },
    { title: '后章', text: '师傅两个字。' },
  ])
  assert.deepEqual(evidence.sectionsFor('赵师傅'), [])
  assert.equal(evidence.supports('赵师傅', [0, 1]), false)
  assert.deepEqual(evidence.sectionsFor('  '), [])
  assert.equal(evidence.supports('', [0]), false)
})

test('evidence locations are deterministic, deduplicated and returned without exposing mutable cached arrays', () => {
  const { evidence } = fixture([
    { title: '第一集', text: '赵师傅：收到。赵师傅转身。', names: ['赵师傅', '赵师傅'] },
    { title: '第二集', text: '赵师傅归还工具。', names: ['赵师傅'] },
  ])
  const ids = evidence.sectionsFor('赵师傅')
  assert.deepEqual(ids, [0, 1])
  ids.push(999)
  assert.deepEqual(evidence.sectionsFor('赵师傅'), [0, 1])
  assert.equal(evidence.supports('赵师傅', [999]), false)
})
