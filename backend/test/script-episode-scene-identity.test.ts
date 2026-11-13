import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptScene } from '../src/infrastructure/database/db.js'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { canRepairEpisodeSceneIdentity, repairEpisodeSceneIdentity } from '../src/modules/script/script-episode-scene-identity.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const mappingStep = 'episode:scene-identity:mapping', reviewStep = 'episode:scene-identity:review'
const mappingContract = 'script_episode_scene_identity_mapping', reviewContract = 'script_episode_scene_identity_review'
function fixture(extra = false) {
  const sources: ScriptScene[] = ['递交证据', '核对口供', '归还钥匙'].map((event, index) => ({
    id: `source-${index}`, project_id: 'project', position: index, episode_number: 1, heading: `旧标题${index}`,
    location: '车站', time_of_day: '夜', characters: '林晚、调查员', action: `  林晚${event}，调查员确认经过。\n`,
    dialogue: `这段${event}的对白必须存在。`, narration: `原旁白${index}`, duration: 20, created_at: 'before', updated_at: 'before',
  }))
  const order = [2, 0, 1]
  const scenes = order.map(index => ({ heading: `新标题${index}`, location: '车站新区域', time_of_day: '夜', characters: '林晚、调查员',
    action: sources[index]!.action + '  重新设计的人物反应。\n', dialogue: sources[index]!.dialogue + '这次说明更清楚。', narration: sources[index]!.narration,
    duration: 30 }))
  if (extra) {
    scenes.splice(1, 0, { ...scenes[0]!, heading: '新增开场', action: '林晚走进车站。', dialogue: '可以开始了吗？' })
    scenes.push({ ...scenes[0]!, heading: '新增尾声', action: '列车离开车站。', dialogue: '' })
  }
  const draft: WorkflowDraft = { stage: 'episode', scope: 'episode', episode_number: 1, operation: 'regenerate',
    artifacts: [{ artifact_type: 'episode_script', title: '  第一集 · 新设计  ', content: '\n完整候选正文：\n' + scenes.map(scene => scene.action + scene.dialogue).join('\n\n') + '\n' }], scenes }
  const documents = [{ title: '第一集原稿', content: sources.map(scene => scene.action + scene.dialogue).join('\n\n') }]
  return { sources, draft, documents }
}
function matches(draft: WorkflowDraft, sources: ScriptScene[]) {
  return sources.filter(source => source.episode_number === draft.episode_number && !draft.scenes.some(scene => scene.source_scene_id === source.id))
    .map(source => {
      const scene_index = draft.scenes.findIndex(scene => scene.source_scene_id === undefined && scene.action.includes(source.action))
      assert.ok(scene_index >= 0)
      return { source_scene_id: source.id, scene_index, source_field: 'action', draft_field: 'action', source_quote: source.action,
        draft_quote: draft.scenes[scene_index]!.action, reason: `同一${source.id}事件、角色及因果环节，已经重新编排位置。` }
    })
}
const mapping = (draft: WorkflowDraft, sources: ScriptScene[]) => ({ matches: matches(draft, sources), unresolved: [] as Array<{ source_scene_id: string; reason: string }> })
const approved = (sources: ScriptScene[]) => ({ checked_source_scene_ids: sources.filter(scene => scene.episode_number === 1).map(scene => scene.id), issues: [] })
function stripIds(draft: WorkflowDraft) {
  return { ...draft, scenes: draft.scenes.map(({ source_scene_id: _id, ...scene }) => scene) }
}
function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return { steps: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }), saved: () => structuredClone(checkpoint) }
}

test('three existing scenes map through reordered 3- and 5-scene candidates with every text byte and new scene preserved', async t => {
  for (const extra of [false, true]) await t.test(extra ? '3 to 5' : '3 to 3', async () => {
    const { draft, sources, documents } = fixture(extra), original = structuredClone({ draft, sources, documents }), calls: string[] = []
    const progress: string[] = [], expected = mapping(draft, sources)
    assert.equal(canRepairEpisodeSceneIdentity(draft, sources), true)
    const result = await repairEpisodeSceneIdentity(draft, sources, documents, async (prompt, contract) => {
      calls.push(contract!.name)
      assert.ok(prompt.includes(JSON.stringify(draft)))
      assert.ok(prompt.includes(JSON.stringify(sources)))
      assert.ok(prompt.includes(JSON.stringify(documents)))
      if (contract?.name === mappingContract) {
        assert.match(prompt, /不能只按数组下标、场号、标题数字/)
        const properties = contract.schema.properties as Record<string, unknown>
        assert.deepEqual(Object.keys(properties), ['matches', 'unresolved'])
        assert.ok(!('content' in properties) && !('scenes' in properties))
        return JSON.stringify(expected)
      }
      assert.equal(contract?.name, reviewContract)
      assert.match(prompt, /真实引文|引文真实/)
      assert.ok(prompt.includes(JSON.stringify(expected)))
      assert.deepEqual(draft, original.draft, 'mapping is not applied before independent review')
      return JSON.stringify(approved(sources))
    }, { onProgress: message => progress.push(message) })
    assert.deepEqual(calls, [mappingContract, reviewContract])
    assert.equal(progress.length, 2)
    assert.notEqual(result, draft)
    assert.deepEqual(stripIds(result), stripIds(draft))
    assert.deepEqual(result.artifacts, draft.artifacts)
    for (const item of expected.matches) assert.equal(result.scenes[item.scene_index]!.source_scene_id, item.source_scene_id)
    assert.equal(result.scenes.filter(scene => scene.source_scene_id === undefined).length, extra ? 2 : 0)
    assert.deepEqual({ draft, sources, documents }, original)
  })
})

test('partial valid bindings stay locked while only missing identities are matched and additional scenes remain unbound', async () => {
  const { draft, sources, documents } = fixture(true), index = draft.scenes.findIndex(scene => scene.action.includes(sources[1]!.action))
  draft.scenes[index]!.source_scene_id = sources[1]!.id
  const original = structuredClone(draft), expected = mapping(draft, sources)
  assert.equal(expected.matches.length, 2)
  const result = await repairEpisodeSceneIdentity(draft, sources, documents, async (_prompt, contract) => {
    if (contract?.name === mappingContract) return JSON.stringify(expected)
    return JSON.stringify(approved(sources))
  })
  assert.equal(result.scenes[index]!.source_scene_id, sources[1]!.id)
  assert.deepEqual(result.scenes[index], draft.scenes[index])
  assert.deepEqual(stripIds(result), stripIds(original))
  assert.equal(result.scenes.filter(scene => scene.source_scene_id === undefined).length, 2)
  assert.deepEqual(draft, original)
})

test('non-redesign and already-complete identity work returns the original object without a model request', async () => {
  const { draft, sources, documents } = fixture(true)
  for (const item of matches(draft, sources)) draft.scenes[item.scene_index]!.source_scene_id = item.source_scene_id
  const unavailable: StructuredGenerator = async () => assert.fail('identity repair must not dispatch')
  assert.equal(canRepairEpisodeSceneIdentity(draft, sources), false)
  assert.equal(await repairEpisodeSceneIdentity(draft, sources, documents, unavailable), draft)
  for (const different of [{ ...draft, operation: 'generate' as const }, { ...draft, stage: 'outline' as const, scope: 'project' as const, episode_number: 0 }]) {
    assert.equal(canRepairEpisodeSceneIdentity(different, sources), false)
    assert.equal(await repairEpisodeSceneIdentity(different, sources, documents, unavailable), different)
  }
})

test('invalid existing identities and insufficient candidate capacity cannot be repaired or sent to a model', async t => {
  for (const invalid of ['unknown', 'cross-episode', 'duplicate', 'too-few-candidates', 'duplicate-sources']) await t.test(invalid, async () => {
    const { draft, sources, documents } = fixture()
    if (invalid === 'unknown') draft.scenes[0]!.source_scene_id = 'made-up'
    if (invalid === 'cross-episode') {
      sources.push({ ...sources[0]!, id: 'episode-2-scene', episode_number: 2 })
      draft.scenes[0]!.source_scene_id = 'episode-2-scene'
    }
    if (invalid === 'duplicate') for (const scene of draft.scenes.slice(0, 2)) scene.source_scene_id = sources[0]!.id
    if (invalid === 'too-few-candidates') draft.scenes.pop()
    if (invalid === 'duplicate-sources') sources.push(structuredClone(sources[0]!))
    const original = structuredClone(draft)
    assert.equal(canRepairEpisodeSceneIdentity(draft, sources), false)
    await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, async () => assert.fail('invalid scope must not reach a model')),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
    assert.deepEqual(draft, original)
  })
})

test('declared missing or ambiguous old content stops after one mapping response without asking for a passing remap', async () => {
  const { draft, sources, documents } = fixture(), f = workspace(), original = structuredClone(draft)
  const unresolved = { matches: matches(draft, sources).slice(0, 2), unresolved: [{ source_scene_id: sources[2]!.id, reason: '归还钥匙事件已被省略，不能强行对应其他新场。' }] }
  let calls = 0
  await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, async (_prompt, contract) => {
    calls++; assert.equal(contract?.name, mappingContract); return JSON.stringify(unresolved)
  }, { steps: f.steps() }), { code: 'episode_scene_identity_unresolved', statusCode: 422 })
  assert.equal(calls, 1)
  assert.equal(f.saved().steps[mappingStep], undefined)
  assert.equal(f.saved().steps[reviewStep], undefined)
  assert.deepEqual(draft, original)
})

test('false quotes, duplicate indexes, locked destinations and incomplete or foreign mapping coverage never become accepted mappings', async t => {
  for (const invalid of ['source-quote', 'draft-quote', 'wrong-field', 'duplicate-index', 'unknown-id', 'cross-episode-id',
    'duplicate-id', 'missing-id', 'both-groups', 'locked-index', 'extra-content']) await t.test(invalid, async () => {
    const { draft, sources, documents } = fixture(), f = workspace()
    if (invalid === 'locked-index') draft.scenes[0]!.source_scene_id = sources[2]!.id
    sources.push({ ...sources[0]!, id: 'other-episode-id', episode_number: 2 })
    const value: any = mapping(draft, sources), original = structuredClone(draft)
    if (invalid === 'source-quote') value.matches[0].source_quote = '原稿从未写过的证据。'
    if (invalid === 'draft-quote') value.matches[0].draft_quote = '候选从未写过的证据。'
    if (invalid === 'wrong-field') value.matches[0].source_field = 'dialogue'
    if (invalid === 'duplicate-index') value.matches[1].scene_index = value.matches[0].scene_index
    if (invalid === 'unknown-id') value.matches[0].source_scene_id = 'invented'
    if (invalid === 'cross-episode-id') value.matches[0].source_scene_id = 'other-episode-id'
    if (invalid === 'duplicate-id') value.matches[1].source_scene_id = value.matches[0].source_scene_id
    if (invalid === 'missing-id') value.matches.pop()
    if (invalid === 'both-groups') value.unresolved.push({ source_scene_id: value.matches[0].source_scene_id, reason: '重复了匹配身份' })
    if (invalid === 'locked-index') value.matches[0].scene_index = 0
    if (invalid === 'extra-content') value.content = '试图在身份步骤改写正文'
    let calls = 0
    await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, async (_prompt, contract) => {
      calls++; assert.equal(contract?.name, mappingContract); return JSON.stringify(value)
    }, { steps: f.steps() }), (error: unknown) => (error as { structuredOutputContract?: string }).structuredOutputContract === mappingContract)
    assert.equal(calls, 2, 'only one ordinary format correction is allowed; independent review cannot authorize invalid evidence')
    assert.deepEqual(draft, original)
    assert.equal(f.saved().steps[mappingStep], undefined)
  })
})

test('independent semantics can reject real quotes and full ID coverage without retrying or overwriting the candidate', async () => {
  const { draft, sources, documents } = fixture(), f = workspace(), original = structuredClone(draft), calls: string[] = []
  const proposal = mapping(draft, sources)
  // Authentic quotes and complete coverage still do not establish semantic
  // identity: pair each old event with the next unrelated new event.
  const indexes = proposal.matches.map(item => item.scene_index)
  proposal.matches.forEach((item, index) => {
    item.scene_index = indexes[(index + 1) % indexes.length]!
    item.draft_quote = draft.scenes[item.scene_index]!.action
  })
  const generate: StructuredGenerator = async (_prompt, contract) => {
    calls.push(contract!.name)
    if (contract?.name === mappingContract) return JSON.stringify(proposal)
    return JSON.stringify({ ...approved(sources), issues: [{ source_scene_id: sources[0]!.id, kind: 'unrelated_match', scene_index: proposal.matches[0]!.scene_index,
      reason: '两处引文真实，但递交证据被错配到核对口供，事件因果身份不对应。' }] })
  }
  await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() }),
    { code: 'episode_scene_identity_review_rejected', statusCode: 422 })
  assert.deepEqual(calls, [mappingContract, reviewContract])
  assert.ok(f.saved().steps[mappingStep])
  assert.equal(f.saved().steps[reviewStep], undefined)
  await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() }), { code: 'episode_scene_identity_review_rejected' })
  assert.deepEqual(calls, [mappingContract, reviewContract, reviewContract], 'continuation never silently replaces a rejected mapping')
  assert.deepEqual(draft, original)
})

test('review must explicitly cover every old source identity before it can approve any mapping', async () => {
  const { draft, sources, documents } = fixture(), f = workspace()
  let reviews = 0
  await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, async (_prompt, contract) => {
    if (contract?.name === mappingContract) return JSON.stringify(mapping(draft, sources))
    reviews++
    return JSON.stringify({ checked_source_scene_ids: [sources[0]!.id, sources[0]!.id, sources[2]!.id], issues: [] })
  }, { steps: f.steps() }), (error: unknown) => (error as { structuredOutputContract?: string }).structuredOutputContract === reviewContract)
  assert.equal(reviews, 2)
  assert.equal(f.saved().steps[reviewStep], undefined)
  assert.ok(draft.scenes.every(scene => scene.source_scene_id === undefined))
})

test('cancellation before mapping, during mapping and during independent review cannot apply an identity', async t => {
  for (const phase of ['before', 'mapping', 'review']) await t.test(phase, async () => {
    const { draft, sources, documents } = fixture(), f = workspace(), controller = new AbortController(), original = structuredClone(draft)
    const reason = new Error(`cancelled ${phase}`), calls: string[] = []
    if (phase === 'before') controller.abort(reason)
    await assert.rejects(repairEpisodeSceneIdentity(draft, sources, documents, async (_prompt, contract) => {
      calls.push(contract!.name)
      if (phase === 'mapping' || phase === 'review' && contract?.name === reviewContract) controller.abort(reason)
      return JSON.stringify(contract?.name === mappingContract ? mapping(draft, sources) : approved(sources))
    }, { steps: f.steps(), signal: controller.signal }), error => error === reason)
    assert.deepEqual(calls, phase === 'before' ? [] : phase === 'mapping' ? [mappingContract] : [mappingContract, reviewContract])
    assert.equal(Boolean(f.saved().steps[mappingStep]), phase === 'review')
    assert.equal(f.saved().steps[reviewStep], undefined)
    assert.deepEqual(draft, original)
  })
})

test('mapping and review checkpoints bind full old and new content and documents while exact retries reuse both', async () => {
  const { draft, sources, documents } = fixture(), f = workspace(), calls: string[] = []
  const generate: StructuredGenerator = async (_prompt, contract) => {
    calls.push(contract!.name)
    return JSON.stringify(contract?.name === mappingContract ? mapping(draft, sources) : approved(sources))
  }
  const first = await repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() })
  const repeated = await repairEpisodeSceneIdentity(draft, sources, documents, async () => assert.fail('exact completed inputs should reuse both steps'), { steps: f.steps() })
  assert.deepEqual(first, repeated)
  assert.deepEqual(calls, [mappingContract, reviewContract])
  sources[0]!.narration += '新的来源事实'
  await repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() })
  documents[0]!.content += '\n新增来源正文。'
  await repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() })
  draft.artifacts[0]!.content += '\n新增候选正文。'
  await repairEpisodeSceneIdentity(draft, sources, documents, generate, { steps: f.steps() })
  assert.deepEqual(calls, Array.from({ length: 4 }, () => [mappingContract, reviewContract]).flat())
  assert.ok(draft.scenes.every(scene => scene.source_scene_id === undefined))
})
