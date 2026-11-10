import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { hasRetainedGenerationWork } from '../src/modules/script/script-workflow-context.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'props' })
const prompt = '完整原任务：全剧道具设计，沿用已确认总纲，真官印缺角与代神册的姓名规则不得改变；仅修字段，不重新创作正文。'
const retained = [
  { artifact_type: 'props', title: '全剧道具清单', content: '真官印、代神册均来自已确认原文，清单正文不得重写。' },
  { artifact_type: 'prop_functions', title: '道具功能与规则', content: '真官印缺角可辨真伪；代神册翻页时显出姓名。' },
  { artifact_type: 'prop_continuity', title: '归属与状态流转', content: '真官印由陆照保管，验明后归还；姓名仍留在册中。' },
]
const invalid = {
  artifact_type: 'prop_visuals', type: 'prop_visuals', status: 'RAW_STATUS_MUST_SURVIVE',
  content: '\n## 真官印\nUNREPAIRED_PROP_TEXT：方形铜印缺一角，铜绿发亮。\n',
}
const repaired = { artifact_type: 'prop_visuals', title: '道具外观与辨识', content: invalid.content.trim() }
const mixed = (item: unknown = invalid) => JSON.stringify({ artifacts: [retained[0], item, ...retained.slice(1)], scenes: [] })
const repairOutput = (repairs: unknown[] = [repaired]) => JSON.stringify({
  repairs: repairs.map(item => { const { content: _body, ...metadata } = item as Record<string, unknown>; return { candidate_id: 'artifact:1', removed_fields: ['prop_visuals', 'episode_script'].includes(String(metadata.artifact_type)) ? ['type', 'status'] : ['status'], ...metadata } }),
})
const is422 = (error: unknown) => {
  assert.ok(error instanceof Error)
  assert.equal((error as Error & { statusCode?: number }).statusCode, 422)
  return true
}

function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return {
    runner: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    get: () => checkpoint,
  }
}
function assertRetained(checkpoint: GenerationCheckpoint) {
  const state = checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[]; pendingArtifacts: unknown[] }
  assert.deepEqual(state.artifacts, retained)
  assert.ok(state.pendingArtifacts.length > 0)
  assert.match(JSON.stringify(state.pendingArtifacts), /UNREPAIRED_PROP_TEXT/)
  assert.match(JSON.stringify(state.pendingArtifacts), /RAW_STATUS_MUST_SURVIVE/)
  return state
}

for (const streaming of [true, false]) test(`${streaming ? 'streaming' : 'non-streaming'} mixed valid and malformed artifacts repair only the malformed document`, async () => {
  const store = workspace()
  let calls = 0, validated = false
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract, onPartial) => {
    calls++
    if (calls === 1) {
      assert.equal(contract?.name, 'workflow_draft')
      if (streaming) {
        onPartial?.('{"artifacts":[' + JSON.stringify(retained[0]) + ',' + JSON.stringify(invalid) + ',')
        const pending = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[]; pendingArtifacts: unknown[] }
        assert.deepEqual(pending.artifacts, [retained[0]])
        assert.match(JSON.stringify(pending.pendingArtifacts), /UNREPAIRED_PROP_TEXT/)
        onPartial?.(mixed())
      }
      return mixed()
    }
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assert.equal((contract!.schema.properties as Record<string, unknown>).scenes, undefined)
    assert.ok((contract!.schema.properties as Record<string, unknown>).repairs)
    assert.ok(text.includes(prompt), 'repair preserves the complete original task')
    assert.match(text, /UNREPAIRED_PROP_TEXT/)
    assert.match(text, /RAW_STATUS_MUST_SURVIVE/)
    assertRetained(store.get())
    return repairOutput()
  }, { steps: store.runner(), validate: value => {
    validated = true
    assert.equal(value.artifacts.length, 4)
    assert.deepEqual(value.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  } })
  assert.equal(calls, 2, 'one initial request and one targeted repair are sufficient')
  assert.ok(validated, 'repaired envelopes still receive final business validation')
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  assert.deepEqual(store.get().steps, {})
})

test('an empty repair cannot discard a malformed document or replace it with fresh semantic generation', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assertRetained(store.get())
})

test('repairing one of two malformed documents cannot silently omit the other document', async () => {
  const store = workspace()
  const otherInvalid = { artifact_type: 'prop_functions', title: '道具功能与规则', status: 'SECOND_INVALID', content: 'SECOND_PENDING_TEXT：必须保留真官印的验真规则。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ artifacts: [retained[0], invalid, otherInvalid, retained[2]], scenes: [] })
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput()
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assert.match(JSON.stringify(store.get().steps['draft:stream:state']!.value), /SECOND_PENDING_TEXT/)
})

test('multiple malformed documents are repaired by stable candidate id even when the repair response order changes', async () => {
  const store = workspace()
  const otherInvalid = { artifact_type: 'prop_functions', title: '道具功能与规则', status: 'SECOND_INVALID', content: 'SECOND_PENDING_TEXT：必须保留真官印的验真规则。' }
  const otherRepaired = { artifact_type: 'prop_functions', title: otherInvalid.title, content: otherInvalid.content }
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ artifacts: [retained[0], invalid, otherInvalid, retained[2]], scenes: [] })
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    const state = store.get().steps['draft:stream:state']!.value as { pendingArtifacts: Array<{ candidate_id: string; original: unknown }> }
    assert.deepEqual(state.pendingArtifacts.map(item => item.candidate_id), ['artifact:1', 'artifact:2'])
    assert.deepEqual(state.pendingArtifacts.map(item => item.original), [invalid, otherInvalid])
    return repairOutput([{ candidate_id: 'artifact:2', ...otherRepaired }, repaired])
  }, { steps: store.runner() })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_functions'), otherRepaired)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type === 'props' || item.artifact_type === 'prop_continuity'), [retained[0], retained[2]])
  assert.deepEqual(store.get().steps, {})
})

test('duplicate repair candidate ids cannot overwrite or stand in for another malformed document', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([repaired, repaired])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assertRetained(store.get())
})

test('unexpected prose in a metadata repair never replaces the server retained original body', async () => {
  const store = workspace()
  let calls = 0
  const result = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return JSON.stringify({ repairs: [{ candidate_id: 'artifact:1', ...repaired, removed_fields: ['type', 'status'], content: '替换成完整无缺角的白玉圆印，并改写剧情。' }] })
  }, { steps: store.runner() })
  assert.equal(calls, 2)
  assert.equal(result.artifacts.find(item => item.artifact_type === 'prop_visuals')!.content, repaired.content)
  assert.doesNotMatch(JSON.stringify(store.get()), /白玉圆印/)
})

test('a field repair preserves an already valid document title while removing extra keys', async () => {
  const store = workspace()
  const titledInvalid = { ...invalid, title: '既有外观标题，不可重新命名' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed(titledInvalid)
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([{ ...repaired, title: '模型另起的新标题' }])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assertRetained(store.get())
  assert.match(JSON.stringify(store.get()), /既有外观标题，不可重新命名/)
  assert.doesNotMatch(JSON.stringify(store.get()), /模型另起的新标题/)
})

for (const [reason, item] of [
  ['out-of-stage document', { ...invalid, artifact_type: 'characters', type: 'characters' }],
  ['duplicate known document type', { ...invalid, artifact_type: 'props', type: 'props' }],
  ['conflicting document type aliases', { ...invalid, type: 'prop_functions' }],
  ['unknown semantic field', { ...invalid, alternative_ending: '真官印被毁，原结局改写。' }],
  ['non-string document content', { ...invalid, content: null }],
] as const) test(`a malformed ${reason} is rejected before targeted repair`, async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.('{"artifacts":[' + retained.map(value => JSON.stringify(value)).join(',') + ',')
    return JSON.stringify({ artifacts: [...retained, item], scenes: [] })
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1, 'known identity conflicts cannot be offered to a repair model')
  const state = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.deepEqual(state.artifacts, retained)
})

test('a targeted repair cannot return or rewrite an already retained valid document', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([repaired, { ...retained[0], content: '模型改写了原清单，删除真官印。' }])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assertRetained(store.get())
  assert.doesNotMatch(JSON.stringify(store.get()), /删除真官印/)
})

test('a targeted repair cannot change its pending document into another stage', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([{ ...repaired, artifact_type: 'characters' }])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2)
  assertRetained(store.get())
})

test('failed targeted repair stops after one call and explicit resume repairs the retained malformed original', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([invalid])
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 2, 'an invalid repair cannot start an automatic correction loop')
  assertRetained(store.get())

  let resumedCalls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    resumedCalls++
    assert.equal(contract?.name, 'script_stage_artifact_repair', 'resume starts with the pending document instead of regenerating the stage')
    assert.ok(text.includes(prompt))
    assert.match(text, /UNREPAIRED_PROP_TEXT/)
    assert.match(text, /RAW_STATUS_MUST_SURVIVE/)
    return repairOutput()
  }, { steps: store.runner() })
  assert.equal(resumedCalls, 1)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
  assert.deepEqual(store.get().steps, {})
})

test('a stream disconnect preserves malformed original artifacts for targeted repair on resume', async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.(mixed())
    throw new TextProviderError('disconnect after mixed closed artifacts', true, 'ECONNRESET')
  }, { steps: store.runner() }), (error: unknown) => (error as { code?: string }).code === 'stage_stream_interrupted')
  assert.equal(calls, 1)
  assertRetained(store.get())

  let resumedCalls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    resumedCalls++
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assert.match(text, /UNREPAIRED_PROP_TEXT/)
    return repairOutput()
  }, { steps: store.runner() })
  assert.equal(resumedCalls, 1)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
})

test('a targeted repair can retry one transport interruption while the whole step stays within three calls', async () => {
  const store = workspace()
  const retries: number[] = []
  let calls = 0, repairPrompt = ''
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    calls++
    if (calls === 1) return mixed()
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assertRetained(store.get())
    if (calls === 2) {
      repairPrompt = text
      throw new TextProviderError('repair transport disconnected before any result', true, 'ECONNRESET')
    }
    assert.equal(calls, 3)
    assert.equal(text, repairPrompt, 'a transport retry reuses the same pending candidate and field-only task')
    return repairOutput()
  }, { steps: store.runner(), onRetry: attempt => retries.push(attempt) })
  assert.equal(calls, 3)
  assert.deepEqual(retries, [2])
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
  assert.deepEqual(store.get().steps, {})
})

test('an initial transport retry followed by an invalid field repair cannot issue a fourth model request', async () => {
  const store = workspace()
  const retries: number[] = []
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) {
      assert.equal(contract?.name, 'workflow_draft')
      throw new TextProviderError('initial transport disconnected before receiving prose', true, 'ECONNRESET')
    }
    if (calls === 2) {
      assert.equal(contract?.name, 'workflow_draft')
      return mixed()
    }
    assert.equal(calls, 3, 'format correction and transport retries must share the step budget')
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return repairOutput([invalid])
  }, { steps: store.runner(), onRetry: attempt => retries.push(attempt) }), is422)
  assert.equal(calls, 3)
  assert.deepEqual(retries, [2])
  assertRetained(store.get())
})

test('a disconnect with only malformed complete documents resumes directly into repair without replaying initial generation', async () => {
  const store = workspace()
  const complete = [retained[0]!, repaired, ...retained.slice(1)]
  const pendingOnly = complete.map(({ title: _title, ...item }, index) => index === 1 ? invalid : { ...item, status: 'PENDING_ONLY_ORIGINAL' })
  const raw = JSON.stringify({ artifacts: pendingOnly, scenes: [] })
  let calls = 0, retries = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.(raw)
    throw new TextProviderError('disconnect after only pending artifacts', true, 'ECONNRESET')
  }, { steps: store.runner(), onRetry: () => { retries++ } }),
  (error: unknown) => (error as { code?: string }).code === 'stage_stream_interrupted')
  assert.equal(calls, 1)
  assert.equal(retries, 0, 'receiving malformed complete prose is enough to prevent replaying the initial stage')
  const state = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[]; pendingArtifacts: Array<{ candidate_id: string; original: unknown }> }
  assert.deepEqual(state.artifacts, [])
  assert.deepEqual(state.pendingArtifacts.map(item => item.original), pendingOnly)
  assert.deepEqual(state.pendingArtifacts.map(item => item.candidate_id), ['artifact:0', 'artifact:1', 'artifact:2', 'artifact:3'])

  let resumedCalls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    resumedCalls++
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assert.match(text, /PENDING_ONLY_ORIGINAL/)
    assert.match(text, /UNREPAIRED_PROP_TEXT/)
    return repairOutput(complete.map((item, index) => ({ candidate_id: `artifact:${index}`, ...item })))
  }, { steps: store.runner() })
  assert.equal(resumedCalls, 1)
  assert.deepEqual(draft.artifacts, complete)
  assert.deepEqual(store.get().steps, {})
})

for (const [reason, item] of [
  ['unknown semantic field', { ...invalid, secret_history: 'BLOCKED_CREATIVE_DATA：真官印来源改变，不能按多余字段丢弃。' }],
  ['conflicting type alias', { ...invalid, type: 'prop_functions' }],
] as const) test(`a sole complete artifact with ${reason} is blocked in one call and counts as retained work`, async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++
    return JSON.stringify({ artifacts: [item], scenes: [] })
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1, 'a blocked first artifact must not trigger generic format correction or semantic generation')
  const state = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[]; scenes: unknown[]; blocks: unknown[]; pendingArtifacts: unknown[] }
  assert.deepEqual(state.artifacts, [])
  assert.deepEqual(state.scenes, [])
  assert.deepEqual(state.blocks, [])
  assert.deepEqual(state.pendingArtifacts, [])
  assert.match(JSON.stringify(state), /UNREPAIRED_PROP_TEXT/)
  assert.equal(hasRetainedGenerationWork(store.get()), true, 'blocked-only prose keeps its original prompt and checkpoint identity')
})

test('a mixed blocked artifact remains in the checkpoint and same-prompt resume cannot skip it as a missing document', async () => {
  const store = workspace()
  const blocked = { ...invalid, secret_history: 'BLOCKED_CREATIVE_DATA：真官印来源改变，不能按多余字段丢弃。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.(mixed(blocked))
    return mixed(blocked)
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1)
  const checkpoint = store.get()
  const state = checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.deepEqual(state.artifacts, retained)
  assert.match(JSON.stringify(checkpoint), /BLOCKED_CREATIVE_DATA/)
  assert.equal(hasRetainedGenerationWork(checkpoint), true)

  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    resumedCalls++
    return repairOutput()
  }, { steps: store.runner() }), is422)
  assert.equal(resumedCalls, 0, 'unrepairable creative data cannot become an invitation to regenerate its missing column')
  assert.match(JSON.stringify(store.get()), /BLOCKED_CREATIVE_DATA/)
})

const episodeRequest = workflowRequest.parse({ stage: 'episode', episode_number: 3 })
const episodeContent = '## 场一：验印\n陆照发现铜印缺角，印纹与原册一致。\n\n## 场二：归还\n陆照验明真伪后将铜印交还。'
const invalidEpisodeArtifact = { artifact_type: 'episode_script', type: 'episode_script', content: episodeContent, status: 'EPISODE_RAW_TO_REPAIR' }
const repairedEpisodeArtifact = { artifact_type: 'episode_script', title: '第3集：验印归还', content: episodeContent }
const episodeScenes = [
  { heading: '场一：验印', location: '院门', time_of_day: '日', characters: '陆照', action: '对照原册，发现铜印缺角。', dialogue: '印纹与原册一致。', narration: '', duration: 10 },
  { heading: '场二：归还', location: '院门', time_of_day: '日', characters: '陆照', action: '验明真伪后将铜印交还。', dialogue: '铜印应归还。', narration: '', duration: 10 },
]
const episodeRepairOutput = () => repairOutput([{ candidate_id: 'artifact:0', ...repairedEpisodeArtifact }])

test('a complete episode envelope with a repairable artifact and valid scenes ends after one field repair', async () => {
  const store = workspace()
  let calls = 0
  const draft = await generateStageDraftWithContinuation(episodeRequest, prompt, async (_text, contract, onPartial) => {
    calls++
    if (calls === 1) {
      const raw = JSON.stringify({ artifacts: [invalidEpisodeArtifact], scenes: episodeScenes })
      onPartial?.(raw)
      return raw
    }
    assert.equal(calls, 2, 'the closed complete scene list needs no semantic continuation')
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    return episodeRepairOutput()
  }, { steps: store.runner() })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts, [repairedEpisodeArtifact])
  assert.deepEqual(draft.scenes, episodeScenes)
  assert.deepEqual(store.get().steps, {})
})

test('a truncated episode still continues its missing scenes after repairing the retained complete artifact', async () => {
  const store = workspace()
  let calls = 0
  const draft = await generateStageDraftWithContinuation(episodeRequest, prompt, async (text, contract, onPartial) => {
    calls++
    if (calls === 1) {
      const raw = '{"artifacts":[' + JSON.stringify(invalidEpisodeArtifact) + '],"scenes":[' + JSON.stringify(episodeScenes[0]) + ',{"heading":"场二：未闭合'
      onPartial?.(raw)
      throw new TextOutputLimitError(raw, 'length')
    }
    if (calls === 2) {
      assert.equal(contract?.name, 'script_stage_artifact_repair')
      return episodeRepairOutput()
    }
    assert.equal(calls, 3)
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.match(text, /模式：scenes/)
    assert.ok(text.includes(JSON.stringify(episodeScenes[0])))
    return JSON.stringify({ blocks: [{ id: 'scene:2', title: repairedEpisodeArtifact.title, content: '', scenes: [episodeScenes[1]] }], complete: true })
  }, { steps: store.runner() })
  assert.equal(calls, 3)
  assert.deepEqual(draft.artifacts, [repairedEpisodeArtifact])
  assert.deepEqual(draft.scenes, episodeScenes)
  assert.deepEqual(store.get().steps, {})
})

test('an illegal second source scene survives failure and cannot disappear after pending artifact repair on resume', async () => {
  const store = workspace()
  const illegalScene = { ...episodeScenes[1], source_scene_id: 'BLOCKED_SECOND_SCENE_MUST_NOT_DISAPPEAR' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(episodeRequest, prompt, async (_text, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [invalidEpisodeArtifact], scenes: [episodeScenes[0], illegalScene] })
    onPartial?.(raw)
    return raw
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1)
  const checkpoint = store.get()
  const state = checkpoint.steps['draft:stream:state']!.value as { scenes: unknown[] }
  assert.deepEqual(state.scenes, [episodeScenes[0]])
  assert.match(JSON.stringify(checkpoint), /BLOCKED_SECOND_SCENE_MUST_NOT_DISAPPEAR/)
  assert.equal(hasRetainedGenerationWork(checkpoint), true)

  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(episodeRequest, prompt, async () => {
    resumedCalls++
    return episodeRepairOutput()
  }, { steps: store.runner() }), is422)
  assert.equal(resumedCalls, 0, 'a blocked scene prevents repairing the artifact and accepting only the earlier scene prefix')
  assert.match(JSON.stringify(store.get()), /BLOCKED_SECOND_SCENE_MUST_NOT_DISAPPEAR/)
})

for (const [reason, item] of [
  ['out-of-stage document', { artifact_type: 'characters', title: '越阶段人物档案', content: 'BLOCKED_TERMINAL_ARTIFACT：人物档案不属于道具阶段。' }],
  ['duplicate document type', { ...retained[0], content: 'BLOCKED_TERMINAL_ARTIFACT：重复清单还改写了真官印归属。' }],
] as const) test(`a terminal ${reason} rejection stays blocked instead of resuming missing columns`, async () => {
  const store = workspace()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++
    onPartial?.('{"artifacts":[' + retained.map(value => JSON.stringify(value)).join(',') + ',')
    return JSON.stringify({ artifacts: [...retained, item], scenes: [] })
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1)
  const state = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.deepEqual(state.artifacts, retained)
  assert.match(JSON.stringify(store.get()), /BLOCKED_TERMINAL_ARTIFACT/)

  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    resumedCalls++
    return JSON.stringify({ blocks: [{ id: 'visual:replacement', title: repaired.title, content: repaired.content, scenes: [] }], complete: true })
  }, { steps: store.runner() }), is422)
  assert.equal(resumedCalls, 0)
  assert.match(JSON.stringify(store.get()), /BLOCKED_TERMINAL_ARTIFACT/)
})

test('a complete fenced mixed envelope repairs only its malformed artifact and preserves all legal prose', async () => {
  const store = workspace()
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract, onPartial) => {
    calls++
    if (calls === 1) {
      assert.equal(contract?.name, 'workflow_draft')
      const raw = '```json\n' + mixed() + '\n```'
      onPartial?.(raw)
      return raw
    }
    assert.equal(calls, 2, 'the fenced response must not prompt a whole-stage format rewrite')
    assert.equal(contract?.name, 'script_stage_artifact_repair')
    assertRetained(store.get())
    return repairOutput()
  }, { steps: store.runner() })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts.filter(item => item.artifact_type !== 'prop_visuals'), retained)
  assert.deepEqual(draft.artifacts.find(item => item.artifact_type === 'prop_visuals'), repaired)
  assert.deepEqual(store.get().steps, {})
})

test('a checkpoint containing only a blocked scene still counts as retained generation work', async () => {
  const store = workspace()
  const illegalScene = { ...episodeScenes[0], source_scene_id: 'BLOCKED_SCENE_ONLY_ORIGINAL' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(episodeRequest, prompt, async () => {
    calls++
    return JSON.stringify({ artifacts: [], scenes: [illegalScene] })
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1)
  const state = store.get().steps['draft:stream:state']!.value as {
    artifacts: unknown[]; scenes: unknown[]; blocks: unknown[]; pendingArtifacts: unknown[]; blockedArtifacts: unknown[]
  }
  assert.deepEqual(state.artifacts, [])
  assert.deepEqual(state.scenes, [])
  assert.deepEqual(state.blocks, [])
  assert.deepEqual(state.pendingArtifacts, [])
  assert.deepEqual(state.blockedArtifacts, [])
  assert.match(JSON.stringify(state), /BLOCKED_SCENE_ONLY_ORIGINAL/)
  assert.equal(hasRetainedGenerationWork(store.get()), true, 'a blocked scene retains the original prompt even without accepted documents or scene prefixes')
})

test('a closed illegal scene in a partial episode stream blocks before a later transport disconnect and remains blocked on resume', async () => {
  const store = workspace()
  const illegalScene = { ...episodeScenes[1], source_scene_id: 'STREAMED_BLOCKED_SECOND_SCENE_ORIGINAL' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(episodeRequest, prompt, async (_text, _contract, onPartial) => {
    calls++
    const partial = '{"artifacts":[' + JSON.stringify(invalidEpisodeArtifact) + '],"scenes":[' +
      JSON.stringify(episodeScenes[0]) + ',' + JSON.stringify(illegalScene) + ','
    onPartial?.(partial)
    throw new TextProviderError('disconnect after the closed illegal second scene', true, 'ECONNRESET')
  }, { steps: store.runner() }), is422)
  assert.equal(calls, 1)
  const checkpoint = store.get()
  const state = checkpoint.steps['draft:stream:state']!.value as { scenes: unknown[] }
  assert.deepEqual(state.scenes, [episodeScenes[0]])
  assert.match(JSON.stringify(checkpoint), /STREAMED_BLOCKED_SECOND_SCENE_ORIGINAL/)
  assert.equal(hasRetainedGenerationWork(checkpoint), true)

  let resumedCalls = 0
  await assert.rejects(generateStageDraftWithContinuation(episodeRequest, prompt, async () => {
    resumedCalls++
    return episodeRepairOutput()
  }, { steps: store.runner() }), is422)
  assert.equal(resumedCalls, 0, 'a complete rejected scene cannot be forgotten merely because its enclosing response never closed')
  assert.match(JSON.stringify(store.get()), /STREAMED_BLOCKED_SECOND_SCENE_ORIGINAL/)
})
