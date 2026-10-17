import assert from 'node:assert/strict'
import { test } from 'node:test'
import { consolidateFindings, findingIdentity, findingsWithHistory, rememberFindingResolutions, reconcileFindingResolutions, resolutionContext } from '../src/modules/script/script-finding-state.js'
import { planSourceReviews } from '../src/modules/script/script-review-plan.js'
import { selectSourceMaterial } from '../src/modules/script/script-source-material.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { ScriptDraftFinding } from '@video-studio/shared/script/script-draft-resolution'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { scriptToolGuidance } from '../src/modules/script/script-tool-guidance.js'
import { groupDraftFindings } from '../src/modules/script/script-finding-groups.js'

const issue: ScriptDraftFinding = { source_key: 'world', kind: 'missing_core_setting', topic: '铜钥匙使用后的记忆代价',
  quote: '使用钥匙的代价暂未说明。', explanation: '开门后损失什么记忆没有落实。', suggestion: '明确记忆损失。' }

test('task guidance retains authoring and save boundaries while loading specialized protocols only when needed', () => {
  const focused = scriptToolGuidance({ workflow: { operation: 'generate' } })
  const discussion = scriptToolGuidance({})
  assert.match(focused, /明确批准的具体版本才能commit_document_draft/)
  assert.match(focused, /保留已确认主线/)
  assert.doesNotMatch(focused, /统一修订任务中，/)
  assert.doesNotMatch(focused, /视觉设定与分镜也可在对话中读取和修订：/)
  assert.match(discussion, /统一修订任务中，/)
  assert.match(discussion, /视觉设定与分镜也可在对话中读取和修订：/)
  assert.match(scriptToolGuidance({ action: { operation: 'revise' } }), /统一修订任务中，/)
  assert.match(scriptToolGuidance({ workflow: { operation: 'generate' }, revisionTask: {} }), /统一修订任务中，/)
})

test('same specific issue groups paraphrases while retaining each location and unrelated issues', () => {
  const paraphrase = { ...issue, quote: '结局使用钥匙后未体现损失。', explanation: '结局没有兑现已设定的代价。' }
  const grouped = consolidateFindings([issue, paraphrase, paraphrase, { ...issue, topic: '铜钥匙的恢复条件' }, { ...issue, source_key: 'characters' }])
  assert.equal(grouped.length, 3)
  assert.equal(grouped[0].related_findings?.length, 1)
  assert.equal(grouped[0].related_findings?.[0].quote, paraphrase.quote)
  assert.equal(findingIdentity(issue), findingIdentity(paraphrase))
  assert.equal(consolidateFindings([{ ...issue, topic: undefined }, { ...issue, topic: undefined, explanation: '另一条独立问题' }]).length, 2)
})

test('manual answers and delegated scope survive rewritten evidence without turning a repair into a passed audit', () => {
  const first = rememberFindingResolutions([], [issue], 'manual', ['只失去开门当天的记忆。'], '已同步人物动机。')
  assert.equal(first[0].status, 'addressed')
  const recurring = { ...issue, quote: '开门损失当天记忆，结局仍未落实。', explanation: '结局因果仍未体现。' }
  const reconciled = reconcileFindingResolutions(first, [recurring])
  assert.equal(reconciled[0].status, 'still_open')
  const visible = findingsWithHistory([recurring], reconciled)[0]
  assert.equal(visible.previous_answer, '只失去开门当天的记忆。')
  assert.equal(visible.repair_attempts, 1)
  const next = rememberFindingResolutions(reconciled, [recurring], 'ai', ['沿用此前决定'], '结局已同步记忆损失。')
  assert.equal(next.length, 1, 'the ledger updates an issue rather than appending duplicate history')
  assert.equal(next[0].attempts, 2)
  assert.equal(next[0].answer, first[0].answer)
  assert.equal(findingsWithHistory([recurring], next)[0].delegated, true)
  assert.equal(reconcileFindingResolutions(next, [])[0].status, 'verified')
})

test('shared repair summaries travel once while every issue retains its answer and status', () => {
  const records = rememberFindingResolutions([], [issue, { ...issue, topic: '钥匙恢复条件' }], 'manual', ['损失当天记忆', '不能恢复'], '本批已同步代价与恢复条件。')
  const context = resolutionContext(records)
  assert.equal(context.decisions.length, 2)
  assert.equal(context.summaries.length, 1)
  assert.equal(context.decisions[0].summary_id, context.decisions[1].summary_id)
  assert.deepEqual(context.decisions.map(item => item.answer), ['损失当天记忆', '不能恢复'])
  assert.equal(JSON.stringify(context).split('本批已同步代价与恢复条件。').length, 2)
})

test('one shared conflict retains all document evidence and follows the same decision across renamed reviews', async () => {
  const father = { ...issue, kind: 'contradiction' as const, source_key: 'hooks', topic: '首次见父集数', quote: '第26集首次见父。' }
  const other = { ...father, source_key: 'foreshadowing', topic: '存活揭示位置', quote: '第23—25集亲见父亲。' }
  const grouped = await groupDraftFindings([father, other, { ...other, topic: '确认存活集位' },
    { ...other, topic: '父亲的真实身份', explanation: '父亲身份与主线冲突。' }], [], async (_prompt, contract) => {
    assert.equal(contract?.name, 'script_finding_groups')
    return JSON.stringify({ groups: [{ topic: '首次见父并确认存活的集数', members: [0, 1, 2] }, { topic: '父亲真实身份', members: [3] }] })
  })
  assert.equal(grouped.length, 2)
  assert.equal(grouped[0].related_findings?.length, 1, 'identical occurrences collapse without dropping a distinct explanation')
  assert.equal(grouped[0].related_findings?.[0].source_key, 'foreshadowing')
  assert.equal(grouped[0].related_findings?.[0].quote, other.quote)
  assert.notEqual(findingIdentity(grouped[0]), findingIdentity(grouped[1]))
  const records = rememberFindingResolutions([], grouped, 'ai', [], '已同步。', ['第26集首次见父，第25集只找到线索。', '保留父亲身份。'])
  assert.match(records[0].decision!, /第26集/)
  const followup = await groupDraftFindings([{ ...other, topic: '姜父被确认活着的时间' }], records, async () => JSON.stringify({
    groups: [{ topic: '首次见父并确认存活的集数', members: [0], resolution_id: records[0].id }],
  }))
  assert.equal(findingIdentity(followup[0]), records[0].id)
  assert.equal(reconcileFindingResolutions(records, followup)[0].status, 'still_open')
})

test('grouping cannot omit an issue, duplicate its membership or invent an authorization', async () => {
  for (const invalid of ['omitted', 'duplicate', 'invented']) {
    const records = rememberFindingResolutions([], [issue], 'manual', ['保留当天记忆代价。'], '已确定。')
    await assert.rejects(groupDraftFindings([issue, { ...issue, topic: '钥匙恢复条件' }], records, async () => JSON.stringify({ groups: [
      { topic: '不能丢弃问题', members: invalid === 'omitted' ? [0] : invalid === 'duplicate' ? [0, 0] : [0, 1],
        ...(invalid === 'invented' ? { resolution_id: 'unapproved' } : {}) },
    ] })), /script_finding_groups 契约/)
  }
})

test('source evidence includes the full manuscript without model selection or supplementary reads', async () => {
  const source = longSource(); let calls = 0
  const material = await selectSourceMaterial(source, '只核对原稿事实', async () => { calls++; throw new Error('unexpected locator') }, undefined, { purpose: 'source_constraints' })
  assert.deepEqual(material, [{ offset: 0, content: source.content }])
  assert.match(material[0].content, /关键证据：开门会失去当天记忆/)
  assert.equal(calls, 0)
})

test('whole-work review plan retains every original passage, quote and distinct meaning in one request', () => {
  const facts = Array.from({ length: 64 }, (_, index) => ({ source_key: index % 2 ? 'characters' : 'world',
    quote: `事实${index}：` + '完整的身份、因果和剧情证据。'.repeat(45), meaning: `第${index}项关键决定` }))
  facts.push({ ...facts[0], meaning: '相同原文的另一项真实含义' })
  const batches = Array.from({ length: 10 }, (_, index) => [{ offset: index * 9000, content: `原文${index}：` + '完整原文。'.repeat(1500) }])
  const plan = planSourceReviews(facts, batches)
  assert.equal(plan.length, 1, 'no source/fact Cartesian partition remains')
  assert.deepEqual(plan[0].original, batches.flat())
  facts.forEach(fact => assert.ok(plan[0].group.some(entry => entry.quote === fact.quote && entry.source_key === fact.source_key && entry.meaning.includes(fact.meaning))))
  assert.equal(plan[0].group.length, 64, 'duplicate quotes merge without losing distinct meanings')
})

function longSource(): ScriptSourceDocument {
  const content = '开场得到铜钥匙。' + '剧情正常推进。'.repeat(2300) + '关键证据：开门会失去当天记忆。' + '随后调查继续。'.repeat(2300) + '结局归还铜钥匙。'
  return { project_id: 'quality', filename: 'story.txt', content, updated_at: '', analysis: {
    id: 'analysis', source_version: 'v1', model_id: 'model', status: 'ready', completed_chunks: 1, total_chunks: 1, error: null, updated_at: '',
    sections: [{ offset: 0, length: content.length, title: '完整故事', summary: '得到钥匙、承受记忆代价并归还。', episode_number: null, characters: [], events: [] }],
    story: { summary: '得到并归还钥匙。', characters: [], timeline: [], threads: [], ending: { summary: '归还钥匙', section_ids: [0] }, uncertainties: [] },
  } }
}

test('source input accepts the exact limit and rejects excess before calling any model', async () => {
  const source = { ...longSource(), content: '剧'.repeat(100000) }; let calls = 0
  const generate = async () => { calls++; throw new Error('unexpected locator') }
  assert.equal((await selectSourceMaterial(source, '全文', generate))[0].content, source.content)
  await assert.rejects(selectSourceMaterial({ ...source, content: source.content + '本' }, '超限', generate), /超过 10 万字符/)
  assert.equal(calls, 0)
})

test('cancelled source reads stop before returning material and never start a selector', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(selectSourceMaterial(longSource(), '全文', async () => { throw new Error('unexpected model') }, controller.signal), { name: 'AbortError' })
})
