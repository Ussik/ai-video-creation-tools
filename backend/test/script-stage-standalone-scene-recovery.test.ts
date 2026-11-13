import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, stageContinuationStateSchema, stageInitialResponseDiagnosticSchema } from '../src/modules/script/script-stage-continuation.js'
import { hasRetainedGenerationWork } from '../src/modules/script/script-workflow-context.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
const prompt = '编写完整第一集，保留事故对话及离站结尾，不能把第一场当作整集完成。'
const first = { heading: '第一场', location: '车站', time_of_day: '夜', characters: '林晚',
  action: '林晚说明事故经过，停顿后等待回应。', dialogue: '先听我把昨晚的经过说完。', narration: '', duration: 25 }
const second = { ...first, heading: '第二场', action: '林晚起身离开车站。', dialogue: '我们现在就走。', duration: 12 }
const prose = '第一场：林晚说明事故经过，停顿后等待回应。她说：“先听我把昨晚的经过说完。”\n\n第二场：林晚起身离开车站。她说：“我们现在就走。”'
const block = (scenes: unknown[] = [first, second]) => ({ id: 'episode-body', title: '第一集 · 事故', content: prose, scenes })
const page = (scenes: unknown[] = [first, second]) => JSON.stringify({ blocks: [block(scenes)], complete: true })
const numberedScenes = (count: number) => Array.from({ length: count }, (_, index) => ({ ...first,
  heading: `第${index + 1}场`, action: `林晚讲述事故的第${index + 1}个经过。`, dialogue: `这是第${index + 1}段不能省略的对白。` }))
const sceneArrayPage = (scenes: ReturnType<typeof numberedScenes>) => JSON.stringify({ blocks: [{ id: 'full-episode', title: '第一集 · 事故',
  content: scenes.map(scene => `${scene.heading}\n${scene.action}\n林晚：${scene.dialogue}`).join('\n\n'), scenes }], complete: true })
const envelope = JSON.stringify({ artifacts: [{ artifact_type: 'episode_script', title: '第一集 · 事故', content: prose }], scenes: [first, second] })
const diagnosticId = 'draft:stream:diagnostic'
function store() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return {
    steps: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    saved: () => structuredClone(checkpoint),
    state: () => stageContinuationStateSchema.parse(checkpoint.steps['draft:stream:state']!.value),
    diagnostic: () => stageInitialResponseDiagnosticSchema.parse(checkpoint.steps[diagnosticId]!.value),
  }
}

test('a terminal bare episode scene is retained while model continuation supplies complete prose and remaining scenes', async () => {
  const f = store(), contracts: string[] = []
  let validations = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    contracts.push(contract!.name)
    if (contracts.length === 1) return JSON.stringify(first)
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.match(text, /模式：document/)
    assert.ok(text.includes(prompt))
    assert.ok(text.includes(JSON.stringify(first)), 'the exact retained scene guides prose completion')
    assert.deepEqual(f.state().scenes, [first])
    assert.deepEqual(f.state().artifacts, [], 'scene fields are never assembled into an invented episode document')
    assert.equal(f.saved().steps[diagnosticId], undefined, 'an intermediate format failure is not persisted as a final failure')
    return page()
  }, { steps: f.steps(), validate: candidate => {
    validations++
    assert.deepEqual(candidate.scenes, [first, second])
    assert.equal(candidate.artifacts[0]!.content, prose)
  } })
  assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks'])
  assert.equal(validations, 1)
  assert.equal(draft.artifacts[0]!.content, prose)
  assert.deepEqual(f.saved().steps, {})
})

test('bare scenes restore optional nulls and preserve real source IDs only for regeneration', async t => {
  for (const regenerate of [false, true]) await t.test(regenerate ? 'regenerate' : 'create', async () => {
    const req = workflowRequest.parse({ stage: 'episode', episode_number: 1, ...(regenerate ? { operation: 'regenerate' } : {}) })
    const rawScene = { ...first, source_scene_id: regenerate ? 'saved-scene-1' : null, location: null, time_of_day: null, narration: null }
    const expected = { ...first, ...(regenerate ? { source_scene_id: 'saved-scene-1' } : {}), location: '', time_of_day: '', narration: '' }
    let calls = 0
    const result = await generateStageDraftWithContinuation(req, prompt, async (_text, contract) => {
      if (++calls === 1) return JSON.stringify(rawScene)
      assert.equal(contract?.name, 'script_stage_blocks')
      return page([expected, second])
    })
    assert.equal(calls, 2)
    assert.deepEqual(result.scenes, [expected, second])
  })
})

test('complete root arrays retain every scene in order, from one scene through the full 100-scene capacity', async t => {
  for (const count of [1, 5, 100]) await t.test(`${count} scenes`, async () => {
    const scenes = numberedScenes(count), raw = JSON.stringify(scenes), f = store(), contracts: string[] = []
    let validations = 0
    const result = await generateStageDraftWithContinuation(request, prompt, async (text, contract, onPartial) => {
      contracts.push(contract!.name)
      if (contracts.length === 1) {
        onPartial?.(raw)
        assert.deepEqual(f.state().scenes, [], 'root arrays are adopted only after successful terminal delivery')
        return raw
      }
      assert.equal(contract?.name, 'script_stage_blocks')
      assert.match(text, /模式：document/)
      assert.deepEqual(f.state().scenes, scenes)
      assert.deepEqual(f.state().artifacts, [])
      for (const scene of scenes) assert.ok(text.includes(JSON.stringify(scene)), 'every original scene remains in the continuation context')
      return sceneArrayPage(scenes)
    }, { steps: f.steps(), validate: candidate => {
      validations++
      assert.deepEqual(candidate.scenes, scenes)
      for (const scene of scenes) {
        assert.ok(candidate.artifacts[0]!.content.includes(scene.action))
        assert.ok(candidate.artifacts[0]!.content.includes(scene.dialogue))
      }
    } })
    assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks'])
    assert.equal(validations, 1)
    assert.deepEqual(result.scenes, scenes)
    assert.deepEqual(f.saved().steps, {})
  })
})

test('root-array continuation cannot omit a middle scene, change scene order or bypass final acceptance', async t => {
  for (const reject of ['missing-middle', 'changed-order', 'business-validation']) await t.test(reject, async () => {
    const scenes = numberedScenes(5), f = store(), businessFailure = new Error('独立审核不接受这份分集正文')
    const continued = reject === 'missing-middle' ? scenes.filter((_, index) => index !== 2)
      : reject === 'changed-order' ? [scenes[0]!, scenes[2]!, scenes[1]!, scenes[3]!, scenes[4]!] : scenes
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => ++calls === 1
      ? JSON.stringify(scenes) : sceneArrayPage(continued), { steps: f.steps(), validate: () => { throw businessFailure } }), error => {
      if (reject === 'business-validation') return error === businessFailure
      return (error as { code?: string }).code === (reject === 'missing-middle' ? 'stage_continuation_missing_scene' : 'stage_continuation_conflict')
    })
    assert.equal(calls, 2)
    assert.equal(f.diagnostic().raw_output, JSON.stringify(scenes))
  })
})

test('root scene arrays normalize optional nulls and retain every explicit regeneration source ID', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1, operation: 'regenerate' })
  const scenes = numberedScenes(5).map((scene, index) => ({ ...scene, source_scene_id: `saved-scene-${index + 1}`, location: '', time_of_day: '', narration: '' }))
  const rawScenes = scenes.map(scene => ({ ...scene, location: null, time_of_day: null, narration: null }))
  let calls = 0
  const result = await generateStageDraftWithContinuation(req, prompt, async (_text, contract) => {
    if (++calls === 1) return JSON.stringify(rawScenes)
    assert.equal(contract?.name, 'script_stage_blocks')
    return sceneArrayPage(scenes)
  }, { validate: candidate => assert.deepEqual(candidate.scenes.map(scene => scene.source_scene_id), scenes.map(scene => scene.source_scene_id)) })
  assert.equal(calls, 2)
  assert.deepEqual(result.scenes, scenes)
})

test('root arrays preserve existing source-ID guards without allowing duplicate or unauthorized IDs into a finished candidate', async t => {
  for (const regenerate of [false, true]) await t.test(regenerate ? 'duplicate-regeneration-ID' : 'unauthorized-create-ID', async () => {
    const req = workflowRequest.parse({ stage: 'episode', episode_number: 1, ...(regenerate ? { operation: 'regenerate' } : {}) })
    const scenes = numberedScenes(5).map((scene, index) => ({ ...scene, source_scene_id: `saved-scene-${regenerate && index === 2 ? 1 : index + 1}` }))
    const f = store()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(req, prompt, async () => {
      calls++; return JSON.stringify(scenes)
    }, { steps: f.steps() }), { code: 'stage_continuation_invalid_unit' })
    assert.equal(calls, 1)
    assert.deepEqual(f.state().scenes, regenerate ? scenes.slice(0, 2) : [])
    assert.deepEqual(f.state().blockedScenes[0]!.original, scenes[regenerate ? 2 : 0])
    assert.equal(f.diagnostic().raw_output, JSON.stringify(scenes), 'the entire rejected array remains available, including later scenes')
  })
})

test('a recovered bare scene cannot be omitted from completed prose or bypass final business validation', async t => {
  for (const reject of ['missing-scene', 'business-validation']) await t.test(reject, async () => {
    const f = store(), businessFailure = new Error('本集内容违反已确认的角色事实')
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      return ++calls === 1 ? JSON.stringify(first) : page(reject === 'missing-scene' ? [second] : [first, second])
    }, { steps: f.steps(), validate: () => { throw businessFailure } }), error => reject === 'missing-scene'
      ? (error as { code?: string }).code === 'stage_continuation_missing_scene' : error === businessFailure)
    assert.equal(calls, 2)
    assert.equal(f.diagnostic().raw_output, JSON.stringify(first))
    assert.equal(f.diagnostic().complete_response, true)
  })
})

test('a forbidden bare source scene ID is quarantined instead of inferred, removed or silently accepted', async () => {
  const f = store(), invalid = { ...first, source_scene_id: 'not-authorized-for-create' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++; return JSON.stringify(invalid)
  }, { steps: f.steps() }), { code: 'stage_continuation_invalid_unit' })
  assert.equal(calls, 1)
  assert.deepEqual(f.state().scenes, [])
  assert.deepEqual(f.state().blockedScenes[0]!.original, invalid)
  assert.equal(f.diagnostic().raw_output, JSON.stringify(invalid))
})

test('malformed collections, multiple roots, nested scenes, unknown fields and incomplete bodies cannot be recovered as scenes', async t => {
  const invalid = [
    ['empty-array', '[]'],
    ['over-capacity-array', JSON.stringify(numberedScenes(101))],
    ['mixed-document-array', JSON.stringify([first, { artifact_type: 'episode_script', title: '第一集', content: prose }, second])],
    ['unknown-middle-array', JSON.stringify([first, { ...second, omitted_body: '不能丢弃的正文' }, first])],
    ['invalid-middle-array', JSON.stringify([first, { ...second, duration: null }, first])],
    ['metadata-only-middle-array', JSON.stringify([first, { heading: '仅有标题', duration: 20 }, second])],
    ['nested-array', JSON.stringify([[first, second]])],
    ['multi-root-arrays', JSON.stringify([first]) + '\n' + JSON.stringify([second])],
    ['wrapped-array', JSON.stringify({ result: [first, second] })],
    ['multiple-roots', JSON.stringify(first) + '\n' + JSON.stringify(second)],
    ['result-wrapper', JSON.stringify({ result: first })],
    ['nested-scene', JSON.stringify({ candidate: first })],
    ['unknown-prose', JSON.stringify({ ...first, omitted_body: '第二场仍有完整正文，不能丢弃。' })],
    ['missing-duration', JSON.stringify({ ...first, duration: undefined })],
    ['null-duration', JSON.stringify({ ...first, duration: null })],
    ['missing-heading', JSON.stringify({ ...first, heading: undefined })],
    ['metadata-only', JSON.stringify({ heading: '仅有标题', duration: 20 })],
    ['fenced-scene', '```json\n' + JSON.stringify(first) + '\n```'],
    ['partial-json', JSON.stringify(first).slice(0, -1)],
  ] as const
  for (const [name, raw] of invalid) await t.test(name, async () => {
    const f = store(), contracts: string[] = []
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
      contracts.push(contract!.name); return raw
    }, { steps: f.steps() }), (error: unknown) => (error as { structuredOutputContract?: string }).structuredOutputContract === 'workflow_draft')
    assert.deepEqual(contracts, ['workflow_draft', 'workflow_draft'], 'ordinary envelope correction remains available without adopting a last nested scene')
    assert.deepEqual(f.state().scenes, [])
    assert.deepEqual(f.state().artifacts, [])
    assert.equal(f.diagnostic().raw_output, raw)
    assert.equal(hasRetainedGenerationWork(f.saved()), false, 'failed-response diagnostics are not accepted creative work')
  })
})

test('bare scenes and root arrays never start episode continuation for a project document stage', async t => {
  for (const raw of [JSON.stringify(first), JSON.stringify([first, second])]) await t.test(raw[0]!, async () => {
    const req = workflowRequest.parse({ stage: 'outline', artifact_types: ['outline'] }), f = store()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(req, prompt, async (_text, contract) => {
      calls++; assert.equal(contract?.name, 'workflow_draft'); return raw
    }, { steps: f.steps() }), /契约/)
    assert.equal(calls, 2)
    assert.deepEqual(f.state().scenes, [])
    assert.equal(hasRetainedGenerationWork(f.saved()), false)
  })
})

test('only the latest complete initial response is saved after final failure, bound to its exact request identity', async () => {
  const f = store(), raw = JSON.stringify({ unrelated: '最后一次完整返回。'.repeat(2000) })
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++
    assert.equal(f.saved().steps[diagnosticId], undefined)
    return calls === 1 ? '{"unrelated":"第一次返回"}' : raw
  }, { steps: f.steps() }), /契约/)
  const diagnostic = f.diagnostic()
  assert.equal(calls, 2)
  assert.ok(raw.length > 5000)
  assert.equal(diagnostic.raw_output, raw)
  assert.equal(diagnostic.raw_length, raw.length)
  assert.equal(diagnostic.truncated, false)
  assert.equal(diagnostic.complete_response, true)
  assert.match(diagnostic.error, /契约/)
  const saved = f.saved().steps[diagnosticId]!
  assert.equal(saved.input_hash, createHash('sha256').update(JSON.stringify({ strategy: 'stage-semantic-stream-v1', request, prompt })).digest('hex'))
  assert.equal(hasRetainedGenerationWork({ steps: { [diagnosticId]: saved } }), false)
  assert.equal(hasRetainedGenerationWork({ steps: { [`work:episode/${diagnosticId}`]: saved } }), false)
})

test('oversized failed response diagnostics retain an explicit bounded preview and original length', async () => {
  const f = store(), raw = JSON.stringify({ unrelated: '未被采用的完整返回。'.repeat(15000) })
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => raw, { steps: f.steps() }), /契约/)
  const diagnostic = f.diagnostic()
  assert.equal(diagnostic.raw_output.length, 100000)
  assert.equal(diagnostic.raw_output, raw.slice(0, 100000))
  assert.equal(diagnostic.raw_length, raw.length)
  assert.equal(diagnostic.truncated, true)
  assert.equal(hasRetainedGenerationWork(f.saved()), false)
})

test('failure diagnostics do not restore prose or completion and are removed after a successful retry', async () => {
  const f = store()
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => '{"unrelated":"失败原文"}', { steps: f.steps() }), /契约/)
  assert.ok(f.saved().steps[diagnosticId])
  let calls = 0
  const result = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++; assert.equal(contract?.name, 'workflow_draft')
    assert.deepEqual(f.state().artifacts, [])
    assert.deepEqual(f.state().scenes, [])
    return envelope
  }, { steps: f.steps() })
  assert.equal(calls, 1)
  assert.deepEqual(result.scenes, [first, second])
  assert.deepEqual(f.saved().steps, {})
})

test('disconnected and output-limited initial deltas never become complete-response diagnostics', async t => {
  for (const limit of [false, true]) await t.test(limit ? 'output-limit' : 'disconnect', async () => {
    const f = store(), tail = '{"scenes":[' + JSON.stringify(first) + ',{"heading":"DISCONNECTED_TAIL'
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
      onPartial?.(tail)
      if (limit) throw new TextOutputLimitError(tail, 'length')
      throw new TextProviderError('upstream disconnected', false, 'bad_response_body')
    }, { steps: f.steps(), maxRounds: 1 }))
    assert.deepEqual(f.state().scenes, [first])
    assert.equal(f.saved().steps[diagnosticId], undefined)
    assert.doesNotMatch(JSON.stringify(f.saved()), /DISCONNECTED_TAIL/)
  })
})
