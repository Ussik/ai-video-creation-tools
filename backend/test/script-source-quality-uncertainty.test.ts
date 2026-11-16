import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'
import { repairSourceQuality } from '../src/modules/script/script-source-quality-repair.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

// Synthetic material only. These tests verify what the real request paths
// convey and preserve; a fake reply cannot establish a model's semantic quality.
const content = '昨日旧主随师傅练过站桩。今日新主才正式拜师。\n规则：依正确法门发力才计修炼进度。\n第二场：炼骨1/100，入门。\n第五场：骨节响起，炼骨入门。\n一记鞭子抽中，进度增加。\n'
const document = { filename: '合成疑点验证.txt', content }
const reviewMarker = '【原稿分析核对资料】\n', repairMarker = '【原稿分析定点修补资料】\n'
const units = scriptSourcePassages(content).flatMap(passage => passage.units)
const ids = (text: string) => [units.find(unit => unit.text.includes(text))!.id]
const signal = () => new AbortController().signal
const originalUncertainties = [
  { description: '必须强制作者额外说明旧主与师傅如何认识，否则无法理解正式拜师。', section_ids: [0] },
  { description: '第二场和第五场都写炼骨入门，绝对矛盾，必须改写。', section_ids: [0] },
  { description: '正确发力才计进度，但鞭击也涨，必须补写才能成立。', section_ids: [0] },
]
const neutralUncertainties = [
  { description: '第二场记炼骨1/100入门，第五场再次表述炼骨入门。两处入门是否表示同一节点、差异如何用于后续创作，原文未明示，待作者确认。', section_ids: [0] },
  { description: '规则要求依正确法门发力，另有受鞭击后进度增加的表现。受击与正确发力的关系及适用条件尚未明示，后续相关动作表现待作者确认。', section_ids: [0] },
]
function stateFor(): ScriptSourceAnalysis {
  return { id: 'quality-uncertainty-contract', source_version: 'synthetic-source', model_id: 'model', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now',
    sections: [{ offset: 0, length: content.length, title: '合成资料', episode_number: null, summary: '人物拜师及修炼表现。', characters: [], events: [], open_threads: [] }],
    story: { summary: '记录拜师与修炼表现。', characters: [], timeline: [], threads: [], ending: { summary: '故事待续。', section_ids: [0] },
      uncertainties: structuredClone(originalUncertainties) } }
}
function input(prompt: string, marker: string) { return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) }
function reviewPolicy(prompt: string) {
  const policy = prompt.slice(0, prompt.indexOf(reviewMarker))
  assert.match(policy, /核对优先级：先检查事件错置、把规划当成已发生、把无依据推断当成事实，以及真实疑点被推测消解；再检查遗漏/)
  assert.match(policy, /完整目录和全部全剧信息中均未保留、且会影响后续创作的具体事实，才报为遗漏/)
  assert.ok(policy.indexOf('核对优先级：') < policy.indexOf('一次通读下方完整原文'))
  assert.match(policy, /原文明确解释或等价说明.*可以构想一种解释/)
  assert.match(policy, /自行补出的境界阶段、动作、条件/)
  assert.match(policy, /具体命题、直接回答它的原文短引及unit_ids/)
  assert.match(policy, /不预设为硬矛盾，也不预设一定自洽/)
  assert.match(policy, /中性保留两处事实与待作者确认的关系/)
  assert.match(policy, /无必要的强制说明要求/)
  assert.match(policy, /原文已明确回收、明确留悬念/)
  assert.match(policy, /区分规划发生和正文已经发生/)
  assert.match(policy, /不能由相邻目录节点.*推定发生集数/)
  assert.match(policy, /状态的起点与终点不自动证明期间每一场景/)
  assert.match(policy, /栏目分配不同、没有逐字重复、正文尚未写到大纲的规划事件，都不是遗漏/)
  assert.match(policy, /不得增写原文没有的音效、反应或动作/)
  assert.match(policy, /判断示例.*不能推导期间全部退场/)
}
function repairPolicy(prompt: string) {
  const policy = prompt.slice(0, prompt.indexOf(repairMarker))
  assert.match(policy, /finding是待复核意见，不是已证实的原文事实/)
  assert.match(policy, /不得沿用其中自行补出的阶段、动作、条件或因果/)
  assert.match(policy, /reason必须逐项写出原事项的具体命题、直接回答它的原文短引及unit_ids/)
  assert.match(policy, /优先整项替换为中性表述/)
  assert.match(policy, /没有可靠的定点修改时沿用无法安全修补的返回规则/)
  assert.match(policy, /无必要强制作者说明的误报可以纠正/)
  assert.match(policy, /保留规划事件与正文已发生事件的区别/)
  assert.match(policy, /不能依据此类推断创造原文未写的场面/)
  assert.match(policy, /栏目分配不同、没有逐字重复、正文尚未写到大纲的规划事件，不需要修改/)
  assert.match(policy, /不得增写原文没有的音效、反应或动作/)
  assert.match(policy, /判断示例.*finding可明确retain_analysis/)
}

test('independent review carries evidence-versus-hypothesis rules before unmodified complete source and analysis', async () => {
  const state = stateFor(), before = structuredClone(state.story)
  await reviewSourceQuality(document, state, async (prompt, contract) => {
    reviewPolicy(prompt)
    assert.equal(contract!.name, 'script_source_quality')
    const body = input(prompt, reviewMarker)
    assert.equal(body.units.map((unit: { text: string }) => unit.text).join(''), content)
    assert.deepEqual(body.story, before)
    assert.equal(body.complete_source, true)
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }, () => {}, signal())
  assert.deepEqual(state.story, before, 'review guidance cannot edit source interpretation itself')
  assert.equal(state.quality!.status, 'passed')
})

test('paged review retains the same evidence rules and complete original uncertainty records after output exhaustion', async () => {
  const state = stateFor(), names: string[] = []
  await reviewSourceQuality(document, state, async (prompt, contract) => {
    names.push(contract!.name); reviewPolicy(prompt)
    assert.deepEqual(input(prompt.split('\n【核对输出分页】')[0]!, reviewMarker).story.uncertainties, originalUncertainties)
    if (contract!.name === 'script_source_quality') throw new TextOutputLimitError('{"findings":[', 'length')
    assert.equal(contract!.name, 'script_source_quality_page')
    assert.equal(input(prompt.split('\n【核对输出分页】')[0]!, reviewMarker).units.map((unit: { text: string }) => unit.text).join(''), content)
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: true })
  }, () => {}, signal())
  assert.deepEqual(names, ['script_source_quality', 'script_source_quality_page'])
  assert.equal(state.quality!.status, 'passed')
})

test('real repair path can retract an unnecessary demand while preserving caller-supplied neutral uncertainties and unrelated facts', async () => {
  const state = stateFor(), before = structuredClone(state), findingEvidence = [ids('昨日旧主'), ids('第二场'), ids('一记鞭子')]
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [
    { kind: 'unsupported', explanation: '撤销无必要的强制说明要求。', unit_ids: findingEvidence[0]! },
    { kind: 'unsupported', explanation: '不把两种表述直接判成硬矛盾，保留其关系待确认。', unit_ids: findingEvidence[1]! },
    { kind: 'causality', explanation: '不以未给出的防御动作消除触发条件疑点。', unit_ids: findingEvidence[2]! },
  ] }
  const findings = structuredClone(state.quality.findings), requests: number[] = []
  await repairSourceQuality(document, state, async (prompt, contract) => {
    repairPolicy(prompt)
    assert.equal(contract!.name, 'script_source_quality_repair')
    const body = input(prompt, repairMarker), number = body.finding_index as number
    requests.push(number)
    assert.equal(body.units.map((unit: { text: string }) => unit.text).join(''), content)
    assert.deepEqual(body.finding, findings[number])
    assert.equal(body.total_findings, 3)
    const index = number === 0 ? 0 : number - 1
    assert.deepEqual(body.story.uncertainties[index], originalUncertainties[number])
    return JSON.stringify({ status: 'patched',
      reason: number === 0 ? `原事项强制解释认识经过；原文“昨日旧主随师傅练过站桩。今日新主才正式拜师。” unit_ids=${findingEvidence[0]}区分既有接触和正式拜师，不必额外要求作者补写。`
        : `原事项措辞过强；原文“${number === 1 ? '第二场：炼骨1/100，入门。' : '一记鞭子抽中，进度增加。'}” unit_ids=${findingEvidence[number]}保留观察事实，尚未明示关系不作解释假设。`,
      changes: [{ target: 'story.uncertainties', section_id: null, operation: number === 0 ? 'remove' : 'replace', index,
        expected: body.story.uncertainties[index], value: number === 0 ? null : neutralUncertainties[number - 1] }] })
  }, () => {}, signal())
  assert.deepEqual(requests, [0, 1, 2])
  assert.deepEqual(state.story!.uncertainties, neutralUncertainties)
  assert.deepEqual(state.story, { ...before.story, uncertainties: neutralUncertainties })
  assert.deepEqual(state.sections, before.sections)
  assert.deepEqual(state.quality!.findings, findings)
  assert.equal(state.quality!.status, 'issues', 'provisional repairs still require independent quality review')
  assert.equal(document.content, content)
})

test('format correction still includes the repair evidence contract and cannot publish an invalid empty patch', async () => {
  const state = stateFor(), before = structuredClone(state.story)
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [
    { kind: 'unsupported', explanation: '核对后没有可靠的定点修改。', unit_ids: ids('第二场') },
  ] }
  let calls = 0
  await assert.rejects(repairSourceQuality(document, state, async prompt => {
    calls++; repairPolicy(prompt)
    const story = input(prompt, repairMarker).story
    assert.deepEqual({ ...story, ...Object.fromEntries(['characters', 'timeline', 'threads', 'uncertainties']
      .map(field => [field, Object.values(story[field])])) }, before)
    if (calls === 1) return JSON.stringify({ status: 'patched', reason: '没有可靠修改但声称完成', changes: [] })
    assert.match(prompt, /至少一项有效修改/)
    return JSON.stringify({ status: 'requires_full_rebuild', reason: '无法确认安全修改，保留原有疑点。', changes: [] })
  }, () => {}, signal()), /无法安全定点修补/)
  assert.equal(calls, 2)
  assert.deepEqual(state.story, before)
  assert.equal(state.quality_repair!.completed_findings, 0)
})
