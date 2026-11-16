import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StateGraph } from '@langchain/langgraph'
import type { ScriptSourceAnalysis, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import type { ModelResultEvent } from '../src/modules/generation/model-result-observation.js'
import { missingSourceStoryNames, repairSourceStoryCharacters, type SourceStoryCharacterRepairCheckpoint } from '../src/modules/script/script-source-story-character-repair.js'

const texts = ['林舟在码头遇见刀疤刘。', '刀疤刘手下数人围来，却被林舟打退。', '车夫推车避让。', '码头工头就是大家所称的工头，在码头管事。']
function fixture() {
  const source = { filename: '短稿.txt', content: texts.join('') }, names = [['林舟', '刀疤刘'], ['刀疤刘手下'], ['车夫'], ['码头工头', '工头']]
  let offset = 0
  const state: ScriptSourceAnalysis = { id: 'story', source_version: 'v', model_id: 'model', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, updated_at: 'now', error: null, sections: texts.map((text, id) => {
      const start = offset; offset += text.length
      return { offset: start, length: text.length, title: `章节${id}`, episode_number: null, summary: text,
        characters: names[id]!.map(name => ({ name, description: name === '刀疤刘手下' ? '数名手下的群体称呼' : '原文明示角色', evidence: { offset: start, quote: text } })), events: [] }
    }) }
  const candidate: ScriptSourceStory = { summary: '保留完整摘要和所有业务约束。', characters: [
    { name: '林舟', aliases: [], description: '打退围来数人的主角', section_ids: [0, 1] },
    { name: '刀疤刘', aliases: [], description: '原文人物，不可并入其手下', section_ids: [0] },
    { name: '码头工头', aliases: [], description: '在码头管事', section_ids: [3] },
  ], timeline: [{ summary: '林舟打退数名手下', section_ids: [1] }], threads: [{ setup: '原有伏笔', payoff: null, section_ids: [0] }],
  ending: { summary: '原有结局信息', section_ids: [3] }, uncertainties: [{ description: '保留真实未知事项', section_ids: [0] }] }
  return { source, state, candidate }
}
function goodPatch() {
  return { add_characters: [
    { name: '刀疤刘手下', aliases: [] as string[], description: '数名手下的群体称呼，围来后被林舟打退。', section_ids: [1] },
    { name: '车夫', aliases: [] as string[], description: '推车避让的角色，姓名未明。', section_ids: [2] },
  ], add_aliases: [{ character_index: 2, aliases: ['工头'], section_ids: [3], identity_evidence: { section_id: 3, quote: texts[3]! } }] }
}
const signal = () => new AbortController().signal
const never = async () => assert.fail('must not dispatch a provider request')

test('complete candidate runs real character graph with zero provider requests', async t => {
  const compile = StateGraph.prototype.compile
  let compiled = 0
  t.mock.method(StateGraph.prototype, 'compile', function (this: StateGraph<any>, ...args: Parameters<typeof compile>) {
    compiled++
    const graph = Reflect.apply(compile, this, args)
    assert.deepEqual(Object.keys(graph.getGraph().nodes).filter(name => !name.startsWith('__')).sort(),
      ['finish_characters', 'repair_characters', 'validate_characters'])
    return graph
  })
  const { state, source, candidate } = fixture()
  candidate.characters.push(...goodPatch().add_characters); candidate.characters[2]!.aliases.push('工头')
  assert.deepEqual(await repairSourceStoryCharacters(state, candidate, source, never, { signal: signal() }), candidate)
  assert.equal(compiled, 1)
})

test('repairs actual-shaped omissions and supported alias while preserving completed fields', async () => {
  const { state, source, candidate } = fixture(), before = structuredClone(candidate)
  let calls = 0, checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
  const result = await repairSourceStoryCharacters(state, candidate, source, async (prompt, contract) => {
    calls++; assert.equal(contract?.name, 'script_source_story_character_repair')
    const marker = '【全剧人物定点修复】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    assert.equal(input.source.content, source.content)
    assert.deepEqual(input.missing_names, ['刀疤刘手下', '车夫', '工头'])
    assert.equal(input.sections.length, 4); assert.equal(input.sections[1].characters[0].evidence.quote, texts[1])
    assert.equal(input.characters.length, 3)
    assert.ok(!('summary' in input) && !('timeline' in input) && !('ending' in input))
    assert.doesNotMatch(prompt, /保留完整摘要和所有业务约束|原有结局信息|原有伏笔/)
    assert.match(prompt, /群体称呼须保留群体性质/)
    return JSON.stringify(goodPatch())
  }, { signal: signal(), onCheckpoint: value => { checkpoint = value } })
  assert.equal(calls, 1); assert.equal(checkpoint?.status, 'completed')
  assert.deepEqual(missingSourceStoryNames(state, result), []); assert.deepEqual(candidate, before)
  for (const key of ['summary', 'timeline', 'threads', 'ending', 'uncertainties'] as const) assert.deepEqual(result[key], before[key])
  assert.deepEqual(result.characters.slice(0, 2), before.characters.slice(0, 2))
  assert.equal(result.characters[2]!.description, before.characters[2]!.description)
  assert.deepEqual(result.characters[2]!.aliases, ['工头']); assert.deepEqual(result.characters[2]!.section_ids, [3])
  assert.match(result.characters[3]!.description, /数名.*群体/)
})

test('missing-name matching normalizes width and whitespace and de-duplicates directory spellings', () => {
  const { state, candidate } = fixture()
  state.sections[0]!.characters.push({ name: ' Ａｌｉｃｅ ', description: '访客', evidence: { offset: 0, quote: texts[0]! } })
  state.sections[1]!.characters.push({ name: 'Alice', description: '同名目录条目', evidence: { offset: 0, quote: texts[1]! } })
  candidate.characters.push({ name: 'Alice', aliases: [], description: '访客', section_ids: [0] })
  assert.deepEqual(missingSourceStoryNames(state, candidate), ['刀疤刘手下', '车夫', '工头'])
})

const invalidPatches: Array<[string, (patch: ReturnType<typeof goodPatch>) => void, RegExp]> = [
  ['unrequested name', patch => { patch.add_characters[0]!.name = '新人物' }, /未授权/],
  ['existing leader used as group alias', patch => { patch.add_characters[0]!.aliases = ['刀疤刘'] }, /别名归并/],
  ['duplicate target', patch => { patch.add_characters[0]!.aliases = ['刀疤刘手下'] }, /别名归并/],
  ['unknown reference', patch => { patch.add_characters[0]!.section_ids = [99] }, /不存在/],
  ['duplicate reference', patch => { patch.add_characters[0]!.section_ids = [1, 1] }, /重复/],
  ['name cited in wrong section', patch => { patch.add_characters[0]!.section_ids = [2] }, /缺少所引章节/],
  ['missing target still absent', patch => { patch.add_characters.pop() }, /仍遗漏.*车夫/],
  ['unknown existing character', patch => { patch.add_aliases[0]!.character_index = 99 }, /不存在/],
  ['quote fabricated', patch => { patch.add_aliases[0]!.identity_evidence.quote = '码头工头就是工头，不存在的原文。' }, /逐字身份依据/],
  ['quote omits existing name', patch => { patch.add_aliases[0]!.identity_evidence.quote = '工头，在码头管事。' }, /逐字身份依据/],
  ['identity quote in another section', patch => { patch.add_aliases[0]!.identity_evidence.section_id = 2 }, /逐字身份依据/],
  ['identity section not cited', patch => { patch.add_aliases[0]!.section_ids = [2] }, /缺少所引章节|逐字身份依据/],
]
for (const [label, mutate, expected] of invalidPatches) test(`rejects ${label} after one patch without regenerating`, async () => {
  const { state, source, candidate } = fixture(), before = structuredClone(candidate), patch = goodPatch()
  mutate(patch)
  let calls = 0, checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
  const generate = async () => { calls++; return JSON.stringify(patch) }
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, generate,
    { signal: signal(), onCheckpoint: value => { checkpoint = value } }), expected)
  assert.equal(calls, 1); assert.equal(checkpoint?.status, 'failed'); assert.deepEqual(candidate, before)
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, generate, { signal: signal(), checkpoint }))
  assert.equal(calls, 1)
})

test('prepared checkpoint blocks dispatch and completed patch replays without a model request', async () => {
  const { state, source, candidate } = fixture()
  let checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
  const result = await repairSourceStoryCharacters(state, candidate, source, async () => JSON.stringify(goodPatch()),
    { signal: signal(), onCheckpoint: value => { checkpoint = value } })
  assert.deepEqual(await repairSourceStoryCharacters(state, candidate, source, never, { signal: signal(), checkpoint }), result)
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, never,
    { signal: signal(), checkpoint: { ...checkpoint!, status: 'prepared', patch: undefined } }), /停止重复派发/)
})

test('changed manuscript, directory or candidate invalidates a saved repair binding', async () => {
  for (const kind of ['source', 'directory', 'candidate', 'model', 'configuration'] as const) {
    const { state, source, candidate } = fixture()
    let calls = 0, checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
    const generate = async () => { calls++; return JSON.stringify(goodPatch()) }
    await repairSourceStoryCharacters(state, candidate, source, generate, { signal: signal(), onCheckpoint: value => { checkpoint = value } })
    if (kind === 'source') source.filename = '修订稿.txt'
    if (kind === 'directory') state.sections[0]!.summary = '已修改目录语义'
    if (kind === 'candidate') candidate.summary = '更新过的完整候选'
    if (kind === 'model') state.model_id = 'another-model'
    if (kind === 'configuration') state.configuration_hash = 'updated-configuration'
    await repairSourceStoryCharacters(state, candidate, source, generate, { signal: signal(), checkpoint })
    assert.equal(calls, 2)
  }
})

test('cancellation before or after provider completion retains original candidate and prepared barrier', async () => {
  const { state, source, candidate } = fixture(), before = structuredClone(candidate), cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, never, { signal: cancelled.signal }), /abort/i)
  const active = new AbortController()
  let checkpoint: SourceStoryCharacterRepairCheckpoint | undefined, calls = 0
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, async () => {
    calls++; active.abort(); return JSON.stringify(goodPatch())
  }, { signal: active.signal, onCheckpoint: value => { checkpoint = value } }), /abort/i)
  assert.equal(calls, 1); assert.equal(checkpoint?.status, 'prepared'); assert.deepEqual(candidate, before)
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, never, { signal: signal(), checkpoint }), /停止重复派发/)
})

test('checkpoint storage failure before dispatch makes no model request', async () => {
  const { state, source, candidate } = fixture()
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, never, {
    signal: signal(), onCheckpoint: () => { throw new Error('存储不可用') },
  }), /存储不可用/)
})

test('storage failure after valid repair keeps prepared state and does not report content failure', async () => {
  const { state, source, candidate } = fixture(), events: ModelResultEvent[] = []
  let checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
  await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: value => { events.push(value) } }, () =>
    repairSourceStoryCharacters(state, candidate, source, async () => JSON.stringify(goodPatch()), {
      signal: signal(), onCheckpoint: value => {
        if (value.status === 'completed') throw new Error('完成检查点无法保存')
        checkpoint = value
      },
    })), /完成检查点无法保存/)
  assert.equal(checkpoint?.status, 'prepared'); assert.equal(events.some(value => value.repair_effect === 'unchanged'), false)
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, never, { signal: signal(), checkpoint }), /停止重复派发/)
})

test('reports fixed business and repair events without manuscript or character names', async () => {
  const { state, source, candidate } = fixture(), events: ModelResultEvent[] = []
  await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: value => { events.push(value) } }, () =>
    repairSourceStoryCharacters(state, candidate, source, async () => JSON.stringify(goodPatch()), { signal: signal() }))
  assert.deepEqual(events.filter(value => value.status === 'invalid_business'),
    [{ phase: 'structure', stage: 'source_analysis', status: 'invalid_business', issue_count: 3 }])
  assert.deepEqual(events.filter(value => value.repaired),
    [{ phase: 'structure', stage: 'content_repair', status: 'valid', issue_count: 0, repaired: true, repair_effect: 'improved' }])
  assert.doesNotMatch(JSON.stringify(events), /林舟|刀疤刘|工头|短稿|码头/)
})

test('bad patch reports unchanged while network failure and cancellation do not report content failure', async () => {
  for (const kind of ['business', 'network', 'cancel'] as const) {
    const { state, source, candidate } = fixture(), events: ModelResultEvent[] = [], controller = new AbortController()
    await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: value => { events.push(value) } }, () =>
      repairSourceStoryCharacters(state, candidate, source, async () => {
        if (kind === 'network') throw new Error('服务不可用')
        if (kind === 'cancel') controller.abort()
        return JSON.stringify({ add_characters: [], add_aliases: [] })
      }, { signal: controller.signal })))
    assert.deepEqual(events.filter(value => value.repaired), kind === 'business'
      ? [{ phase: 'structure', stage: 'content_repair', status: 'invalid_business', issue_count: 1, repaired: true, repair_effect: 'unchanged' }] : [])
  }
})


test('alias repair appends actual source references and preserves all existing names, aliases and reference order', async () => {
  const { state, source, candidate } = fixture(), patch = goodPatch()
  candidate.characters[2]!.aliases = ['码头管事']
  candidate.characters[2]!.section_ids = [0, 1]
  const result = await repairSourceStoryCharacters(state, candidate, source, async () => JSON.stringify(patch), { signal: signal() })
  assert.deepEqual(result.characters[2]!.aliases, ['码头管事', '工头'])
  assert.deepEqual(result.characters[2]!.section_ids, [0, 1, 3])
  assert.equal(result.characters[2]!.description, candidate.characters[2]!.description)
})

test('safe independent target records remain available when the manuscript provides no direct identity quotation', async () => {
  const { state, source, candidate } = fixture(), patch = goodPatch()
  patch.add_aliases = []
  patch.add_characters.push({ name: '工头', aliases: [], description: '原文明示的工头称呼，暂不认定与已有角色的身份关系。', section_ids: [3] })
  const result = await repairSourceStoryCharacters(state, candidate, source, async () => JSON.stringify(patch), { signal: signal() })
  assert.deepEqual(result.characters.slice(0, candidate.characters.length), candidate.characters)
  assert.equal(result.characters.at(-1)!.name, '工头')
  assert.deepEqual(missingSourceStoryNames(state, result), [])
})

test('duplicate alias index and alias overflow cannot alter an existing character', async () => {
  for (const kind of ['duplicate-index', 'overflow'] as const) {
    const { state, source, candidate } = fixture(), patch = goodPatch()
    if (kind === 'duplicate-index') patch.add_aliases.push(structuredClone(patch.add_aliases[0]!))
    else candidate.characters[2]!.aliases = Array.from({ length: 8 }, (_, id) => `既有别名${id}`)
    let calls = 0
    await assert.rejects(repairSourceStoryCharacters(state, candidate, source, async () => { calls++; return JSON.stringify(patch) }, { signal: signal() }))
    assert.equal(calls, 1)
  }
})


test('independent missing targets cannot be merged as new-character aliases even with both valid source references', async () => {
  const { state, source, candidate } = fixture(), before = structuredClone(candidate), patch = goodPatch()
  patch.add_characters = [{ name: '刀疤刘手下', aliases: ['车夫'], description: '未经证据认定为同一人', section_ids: [1, 2] }]
  let calls = 0, checkpoint: SourceStoryCharacterRepairCheckpoint | undefined
  const generate = async (prompt: string) => {
    calls++
    assert.match(prompt, /aliases必须为空/)
    assert.match(prompt, /禁止在新增人物之间进行别名归并/)
    return JSON.stringify(patch)
  }
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, generate,
    { signal: signal(), onCheckpoint: value => { checkpoint = value } }), /新增人物必须.*独立保留.*不能.*别名归并/)
  assert.equal(calls, 1, 'semantic identity rejection must not request another patch')
  assert.equal(checkpoint?.status, 'failed')
  assert.deepEqual(candidate, before)
  await assert.rejects(repairSourceStoryCharacters(state, candidate, source, generate, { signal: signal(), checkpoint }), /别名归并/)
  assert.equal(calls, 1, 'failed identity patch cannot dispatch automatically')
})
