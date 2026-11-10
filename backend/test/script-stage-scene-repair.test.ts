import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'outline', intent: 'source_outline', artifact_types: ['outline'] })
const artifacts = [{ artifact_type: 'outline', title: '完整故事大纲', content: '林舟得到钥匙，调查真相，最终交还钥匙。' }]
const scene = { heading: '第一场', location: '院子', time_of_day: '日', characters: '林舟', action: '交还钥匙', dialogue: '物归原主。', narration: '', duration: 10 }
const original = { artifacts, scenes: [scene] }
const corrected = { artifacts, scenes: [] }
const prompt = '根据完整原稿生成故事大纲，保持结局。'

test('a complete outline with extra scenes gets one explicit correction preserving all document prose', async () => {
  const steps = createGenerationSteps(), notices: string[] = []
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract, onPartial) => {
    if (++calls === 1) {
      onPartial?.(JSON.stringify(original))
      return JSON.stringify(original)
    }
    assert.equal(contract?.name, 'script_stage_scene_repair')
    assert.ok(text.includes(prompt))
    assert.ok(text.includes(JSON.stringify(original)), 'the full rejected candidate remains available to the correction')
    assert.match(text, /程序原样保留/); assert.equal((contract!.schema.properties as Record<string, unknown>).artifacts, undefined)
    return JSON.stringify({ discard_scenes: true, scene_count: 1 })
  }, { steps, onProgress: notice => notices.push(notice), validate: draft => assert.deepEqual(draft.artifacts, artifacts) })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts, artifacts)
  assert.deepEqual(draft.scenes, [])
  assert.ok(notices.length)
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('a failed scene correction cannot drop scenes silently or retry indefinitely and can resume from its original candidate', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const runner = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++
    return JSON.stringify(original)
  }, { steps: runner() }), (error: any) => error.code === 'stage_scene_repair_invalid')
  assert.equal(calls, 2, 'one initial request and one correction only')
  const state = checkpoint.steps['draft:stream:state']!.value as any
  assert.deepEqual(state.pendingSceneRepair, original)
  assert.deepEqual(state.artifacts, artifacts)
  const result = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    calls++
    assert.equal(contract?.name, 'script_stage_scene_repair')
    assert.ok(text.includes(JSON.stringify(original)))
    return JSON.stringify({ discard_scenes: true, scene_count: 1 })
  }, { steps: runner() })
  assert.equal(calls, 3, 'resume corrects the quarantined candidate instead of regenerating its prose')
  assert.deepEqual(result.artifacts, artifacts)
  assert.deepEqual(checkpoint.steps, {})
})

test('a scene correction that changes a title or body is rejected with the original prose retained', async t => {
  for (const field of ['title', 'content'] as const) await t.test(field, async () => {
    const steps = createGenerationSteps()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      if (++calls === 1) return JSON.stringify(original)
      return JSON.stringify({ artifacts: [{ ...artifacts[0], [field]: '篡改后的内容' }], scenes: [] })
    }, { steps }), (error: any) => error.code === 'stage_scene_repair_invalid')
    assert.equal(calls, 2)
    assert.deepEqual((steps.checkpoint.steps['draft:stream:state']!.value as any).pendingSceneRepair, original)
  })
})

test('correcting scene structure still runs final business validation', async () => {
  const steps = createGenerationSteps(), rejection = new Error('原稿不支持这个结局')
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    return JSON.stringify(++calls === 1 ? original : { discard_scenes: true, scene_count: 1 })
  }, { steps, validate: () => { throw rejection } }), error => error === rejection)
  assert.equal(calls, 2)
  assert.deepEqual((steps.checkpoint.steps['draft:stream:state']!.value as any).pendingSceneRepair, original)
})

test('nullable optional scene fields from a strict provider can be corrected without changing outline prose', async () => {
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async () => JSON.stringify(++calls === 1
    ? { artifacts, scenes: [{ ...scene, source_scene_id: null }] } : { discard_scenes: true, scene_count: 1 }))
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts, artifacts)
  assert.deepEqual(draft.scenes, [])
})

test('a terminal snapshot cannot change retained prose before scene correction', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++; onPartial?.(JSON.stringify(original))
    return JSON.stringify({ ...original, artifacts: [{ ...artifacts[0], content: '改写结局。' }] })
  }), (error: any) => error.code === 'stage_continuation_conflict')
  assert.equal(calls, 1)
})

test('cancelling a scene correction retains its candidate and does not adopt the response', async () => {
  const controller = new AbortController(), steps = createGenerationSteps()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) return JSON.stringify(original)
    controller.abort()
    return JSON.stringify({ discard_scenes: true, scene_count: 1 })
  }, { signal: controller.signal, steps }), (error: any) => error.name === 'AbortError')
  assert.equal(calls, 2)
  assert.deepEqual((steps.checkpoint.steps['draft:stream:state']!.value as any).pendingSceneRepair, original)
})

test('extra scenes cannot disguise missing documents or a malformed scene as a repairable complete outline', async t => {
  for (const invalid of [
    { artifacts: [], scenes: [scene] },
    { artifacts, scenes: [{ ...scene, duration: null }] },
  ]) await t.test(JSON.stringify(invalid), async () => {
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
      calls++; const raw = JSON.stringify(invalid); onPartial?.(raw); return raw
    }), (error: any) => error.code === 'stage_continuation_invalid_unit')
    assert.equal(calls, 1)
  })
})

test('a truncated outline envelope cannot discard quarantined scenes and report completion', async () => {
  const steps = createGenerationSteps()
  const raw = JSON.stringify(original).slice(0, -1)
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    calls++; onPartial?.(raw)
    throw new TextOutputLimitError(raw, 'length')
  }, { steps }), (error: any) => error.code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
  const state = steps.checkpoint.steps['draft:stream:state']!.value as any
  assert.deepEqual(state.artifacts, artifacts)
  assert.deepEqual(state.blockedScenes.map((item: any) => item.original), [scene])
  assert.equal(state.pendingSceneRepair, null, 'only a complete envelope can authorize a scene correction')
})
