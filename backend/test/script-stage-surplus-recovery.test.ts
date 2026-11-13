import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, stageContinuationStateSchema } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'characters', intent: 'stage_design', artifact_types: ['characters'] })
const prompt = '根据完整原稿只编写人物小传。人物关系由后续独立任务处理，保持既有人物事实。'
const characters = { artifact_type: 'characters', title: '全剧人物小传', content: '## 林舟\n林舟保管钥匙，承诺查明真相后归还。\n\n## 陆照\n陆照追查钥匙的来历。' }
const relationships = { artifact_type: 'relationships', title: '全剧人物关系', content: '\n## 额外返回的人物关系\nSURPLUS_ORIGINAL：林舟与陆照因钥匙相互试探，最后达成合作。\n' }

function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return {
    steps: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    saved: () => structuredClone(checkpoint),
  }
}

function containsOriginal(value: unknown, original: unknown): boolean {
  if (JSON.stringify(value) === JSON.stringify(original)) return true
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(child => containsOriginal(child, original))
}

function assertSurplusRetained(checkpoint: GenerationCheckpoint, original: unknown = relationships) {
  const archives = Object.entries(checkpoint.steps).filter(([key]) => key.includes('surplus'))
  assert.ok(archives.length > 0, 'a separate checkpoint keeps the extra document outside the accepted draft')
  assert.ok(archives.some(([, entry]) => containsOriginal(entry.value, original)), 'the complete raw surplus object, including its original whitespace, survives')
}

function seedBlocked(store: ReturnType<typeof workspace>, blocked: unknown = relationships) {
  store.steps().retain('draft:stream:state', '历史人物任务异常断点',
    { strategy: 'stage-semantic-stream-v1', request, prompt }, {
      version: 1, round: 1, initialEnded: false, initialComplete: false,
      artifacts: [characters], scenes: [], target: null, mode: 'document', blocks: [], noProgress: 0,
      blockedArtifacts: [{ candidate_id: 'artifact:1', original: blocked }],
    }, value => stageContinuationStateSchema.parse(value))
}

for (const streaming of [true, false]) test(`${streaming ? 'streaming' : 'non-streaming'} single-document task isolates a valid extra same-stage document`, async () => {
  const store = workspace()
  const raw = JSON.stringify({ artifacts: [characters, relationships], scenes: [] })
  let calls = 0, validations = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract, onPartial) => {
    calls++
    assert.equal(contract?.name, 'workflow_draft')
    if (streaming) {
      onPartial?.('{"artifacts":[' + JSON.stringify(characters) + ',')
      onPartial?.(raw)
    }
    return raw
  }, { steps: store.steps(), validate: value => {
    validations++
    assert.deepEqual(value.artifacts, [characters], 'business validation sees only the requested document')
  } })
  assert.equal(calls, 1, 'a valid requested document does not need another model request because of a surplus sibling')
  assert.equal(validations, 1)
  assert.deepEqual(draft.artifacts, [characters])
  assert.deepEqual(draft.scenes, [])
  assert.deepEqual(draft.artifact_types, ['characters'])
  assert.equal(store.saved().steps['draft:stream:state'], undefined)
  assertSurplusRetained(store.saved())
})

test('a historical blocked same-stage sibling resumes the accepted document without requesting a model', async () => {
  const store = workspace()
  seedBlocked(store)
  let calls = 0, validations = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async () => {
    calls++
    throw new Error('the already complete character biography must not be regenerated')
  }, { steps: store.steps(), validate: value => {
    validations++
    assert.deepEqual(value.artifacts, [characters])
  } })
  assert.equal(calls, 0)
  assert.equal(validations, 1)
  assert.deepEqual(draft.artifacts, [characters])
  assert.deepEqual(draft.scenes, [])
  assert.equal(store.saved().steps['draft:stream:state'], undefined)
  assertSurplusRetained(store.saved())
})

const invalidExtras = [
  ['duplicate requested document', { ...characters, content: 'DUPLICATE_ORIGINAL：林舟撕毁钥匙，推翻已保留小传。' }],
  ['cross-stage document', { artifact_type: 'outline', title: '错误阶段的大纲', content: 'CROSS_STAGE_ORIGINAL：这份文档不属于人物阶段。' }],
  ['extra creative field', { ...relationships, alternative_ending: 'UNKNOWN_FIELD_ORIGINAL：另一版结局不得被忽略。' }],
] as const

for (const [reason, original] of invalidExtras) test(`${reason} remains blocked during initial generation and historical resume`, async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [characters, original], scenes: [] })
    onPartial?.(raw)
    return raw
  }, { steps: store.steps() }), (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
  assert.equal(calls, 1)
  const state = stageContinuationStateSchema.parse(store.saved().steps['draft:stream:state']!.value)
  assert.deepEqual(state.artifacts, [characters], 'the valid requested prose remains unchanged after rejection')
  assert.ok(containsOriginal(state.blockedArtifacts, original), 'rejected original creative data remains in its blocking checkpoint')

  const historical = workspace()
  seedBlocked(historical, original)
  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    resumedCalls++
    return JSON.stringify({ artifacts: [characters], scenes: [] })
  }, { steps: historical.steps() }), (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
  assert.equal(resumedCalls, 0, 'surplus recovery cannot silently bypass a substantive conflict')
  const retained = stageContinuationStateSchema.parse(historical.saved().steps['draft:stream:state']!.value)
  assert.deepEqual(retained.artifacts, [characters])
  assert.ok(containsOriginal(retained.blockedArtifacts, original))
})

test('duplicate surplus document types cannot be silently isolated and accepted', async () => {
  const store = workspace()
  const duplicate = { ...relationships, content: 'CONFLICTING_SURPLUS_ORIGINAL：林舟与陆照始终敌对，未曾合作。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [characters, relationships, duplicate], scenes: [] })
    onPartial?.(raw)
    return raw
  }, { steps: store.steps() }), (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
  assert.equal(calls, 1)
  const state = stageContinuationStateSchema.parse(store.saved().steps['draft:stream:state']!.value)
  assert.deepEqual(state.artifacts, [characters])
  assert.ok(containsOriginal(state.blockedArtifacts, duplicate), 'conflicting extra prose remains blocked instead of becoming an accepted sibling')
})

test('a content-filtered response rolls back its surplus archive before a later response supplies different prose', async () => {
  const store = workspace()
  const rejected = JSON.stringify({ artifacts: [characters, relationships], scenes: [] })
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.(rejected)
    throw new TextProviderError('the upstream provider rejected this response', false, 'content_filter')
  }, { steps: store.steps() }), { upstreamCode: 'content_filter' })
  assert.equal(calls, 1)
  assert.equal(store.saved().steps['draft:stream:state'], undefined, 'none of the filtered response is accepted')
  assert.equal(Object.keys(store.saved().steps).some(key => key.includes('surplus')), false, 'surplus prose from the filtered response is rolled back too')

  const replacement = { ...relationships, content: '\nREPLACEMENT_SURPLUS_ORIGINAL：林舟与陆照从未敌对，基于共同目标合作。\n' }
  let resumedCalls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    resumedCalls++
    const raw = JSON.stringify({ artifacts: [characters, replacement], scenes: [] })
    onPartial?.(raw)
    return raw
  }, { steps: store.steps() })
  assert.equal(resumedCalls, 1, 'the rejected response cannot create a conflict with later surplus prose')
  assert.deepEqual(draft.artifacts, [characters])
  assertSurplusRetained(store.saved(), replacement)
  assert.ok(!containsOriginal(store.saved(), relationships), 'the original filtered surplus cannot reappear in the accepted checkpoint')
})

test('identical surplus siblings with distinct candidate ids stay blocked on historical resume', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [characters, relationships, relationships], scenes: [] })
    onPartial?.(raw)
    return raw
  }, { steps: store.steps() }), (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
  assert.equal(calls, 1)
  const state = stageContinuationStateSchema.parse(store.saved().steps['draft:stream:state']!.value)
  assert.deepEqual(state.artifacts, [characters])
  assert.ok(state.blockedArtifacts.some(item => item.candidate_id === 'artifact:2' && containsOriginal(item.original, relationships)))
  assertSurplusRetained(store.saved())

  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    resumedCalls++
    return JSON.stringify({ artifacts: [characters], scenes: [] })
  }, { steps: store.steps() }), (error: unknown) => (error as { statusCode?: number }).statusCode === 422)
  assert.equal(resumedCalls, 0, 'different candidate ids remain a duplicate-document conflict even when their prose is identical')
  const retained = stageContinuationStateSchema.parse(store.saved().steps['draft:stream:state']!.value)
  assert.deepEqual(retained.artifacts, [characters])
  assert.ok(retained.blockedArtifacts.some(item => item.candidate_id === 'artifact:2' && containsOriginal(item.original, relationships)))
  assertSurplusRetained(store.saved())
})
