import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, type StageStreamGenerator } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'outline' })
const sourcePrompt = 'CREATOR: 画风水墨，不改变结局。\nFULL_SOURCE: 开场林舟得钥匙。' + '调查与冲突。'.repeat(4000) + '终局林舟交还钥匙。'
const artifact = (type: string) => ({ artifact_type: type, title: type, content: `完整的${type}剧情与具体设定。` })
const body = (stage: keyof typeof scriptStageArtifacts) => ({ artifacts: scriptStageArtifacts[stage].map(artifact), scenes: [] })
const block = (id: string, content = `${id}完整剧情。`, scenes: unknown[] = []) => ({ id, title: '分集大纲', content, scenes })
const scene = (heading: string, source_scene_id?: string) => ({ ...(source_scene_id ? { source_scene_id } : {}), heading, location: '院子', time_of_day: '日', characters: '林舟', action: '交接钥匙', dialogue: '我会归还。', narration: '', duration: 10 })
const truncation = (artifacts: unknown[], tail = '{"artifact_type":"episode_outline","title":"分集大纲","content":"未写完') =>
  '{"artifacts":[' + artifacts.map(item => JSON.stringify(item)).join(',') + (artifacts.length ? ',' : '') + tail
function workspace() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  return { runner: () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }), get: () => checkpoint }
}

test('normal stage generation is one full-source request and leaves no duplicate streaming checkpoint', async () => {
  let calls = 0
  const steps = createGenerationSteps()
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++; assert.equal(contract?.name, 'workflow_draft'); assert.ok(prompt.includes(sourcePrompt))
    const result = JSON.stringify(body('outline'))
    onPartial?.(result)
    assert.equal((steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }).artifacts.length, 9)
    return result
  }, { steps })
  assert.equal(calls, 1); assert.equal(draft.artifacts.length, 9)
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('length failure retains complete documents, discards partial JSON and continues episodes as complete semantic units', async () => {
  const original = body('outline').artifacts.slice(0, -1), steps = createGenerationSteps()
  let calls = 0
  const messages: string[] = []
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++; assert.ok(prompt.includes(sourcePrompt), 'every request retains full source and exact creator constraints')
    if (calls === 1) {
      assert.equal(contract?.name, 'workflow_draft')
      const raw = truncation(original); onPartial?.(raw)
      assert.equal((steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }).artifacts.length, 8)
      throw new TextOutputLimitError(raw, 'max_output_tokens')
    }
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.ok(prompt.includes(JSON.stringify(original)), 'complete documents remain available without regeneration')
    assert.ok(!prompt.includes('"content":"未写完'), 'truncated string is never supplied as finished prose')
    if (calls === 2) {
      const raw = '{"blocks":[' + JSON.stringify(block('episode:1', '第1集：拿到钥匙，承诺归还。')) + ',{"id":"episode:2","title":"分集大纲","content":"半截'
      onPartial?.(raw); throw new TextOutputLimitError(raw, 'length')
    }
    assert.match(prompt, /第1集：拿到钥匙，承诺归还/)
    return JSON.stringify({ blocks: [block('episode:2', '第2集：履行承诺，交还钥匙。')], complete: true })
  }, { steps, onProgress: message => messages.push(message) })
  assert.equal(calls, 3); assert.equal(draft.artifacts.length, 9)
  assert.deepEqual(draft.artifacts.slice(0, -1), original)
  assert.equal(draft.artifacts.at(-1)!.content, '第1集：拿到钥匙，承诺归还。\n\n第2集：履行承诺，交还钥匙。')
  assert.ok(messages.length); assert.deepEqual(steps.checkpoint.steps, {})
})

test('an invalid stage envelope with retained documents continues only missing targets instead of issuing a competing whole-stage correction', async () => {
  const original = body('outline').artifacts.slice(0, -1), steps = createGenerationSteps()
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++
    if (calls === 1) {
      const raw = JSON.stringify({ artifacts: original, scenes: [], unexpected: true })
      onPartial?.(raw)
      return raw
    }
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.ok(!prompt.includes('【一次格式修正】'), 'the generic rewrite instruction is not sent after retaining documents')
    assert.ok(prompt.includes(JSON.stringify(original)))
    assert.match(prompt, /当前目标：episode_outline/)
    assert.match(prompt, /不要求本轮重新返回整阶段/)
    return JSON.stringify({ blocks: [block('episode:1')], complete: true })
  }, { steps })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts.slice(0, -1), original)
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('retained complete documents can survive a malformed envelope while final business validation remains mandatory', async () => {
  const complete = body('outline')
  let calls = 0, validations = 0
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, contract, onPartial) => {
    calls++; assert.equal(contract?.name, 'workflow_draft')
    const raw = JSON.stringify({ ...complete, unexpected: true })
    onPartial?.(raw)
    return raw
  }, { validate: value => { validations++; assert.deepEqual(value.artifacts, complete.artifacts) } })
  assert.equal(calls, 1)
  assert.equal(validations, 1)
  assert.deepEqual(draft.artifacts, complete.artifacts)
})

test('a semantic rejection of retained documents is never treated as successful envelope recovery', async () => {
  const steps = createGenerationSteps()
  let calls = 0
  const rejection = Object.assign(new Error('原文证据不支持当前结局'), { code: 'source_evidence_conflict', statusCode: 422 })
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify(body('outline'))
    onPartial?.(raw)
    return raw
  }, { steps, validate: () => { throw rejection } }), error => error === rejection)
  assert.equal(calls, 1, 'a semantic rejection cannot start a whole-stage rewrite against retained prose')
  assert.equal((steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }).artifacts.length, 9)
})

test('a duplicate artifact cannot be discarded to make a rejected complete response pass', async () => {
  const steps = createGenerationSteps(), original = body('outline').artifacts
  const raw = JSON.stringify({ artifacts: [...original, { ...original[0], content: '林舟撕毁钥匙，从未承诺归还。' }], scenes: [] })
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++; onPartial?.(raw); return raw
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_conflict')
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(steps.checkpoint).includes('撕毁钥匙'))
})

test('a complete terminal response that changes retained prose still fails before envelope recovery', async () => {
  const steps = createGenerationSteps(), original = body('outline')
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++; onPartial?.(JSON.stringify(original))
    return JSON.stringify({ artifacts: original.artifacts.map((item, index) => index ? item : { ...item, content: '林舟撕毁钥匙，从未承诺归还。' }), scenes: [] })
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_conflict')
  assert.equal(calls, 1)
  assert.deepEqual((steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }).artifacts, original.artifacts)
})

test('an artifact from another stage cannot be filtered out before accepting retained documents', async () => {
  let calls = 0
  const original = body('outline').artifacts
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [...original, artifact('characters')], scenes: [] })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
})

test('scenes cannot be filtered out of a malformed envelope for a non-episode stage', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: body('outline').artifacts, scenes: [{ ...scene('错误分场'), duration: null }] })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
})

test('a malformed closed document cannot be ignored as damage to the outer envelope', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    const raw = JSON.stringify({ artifacts: [...body('outline').artifacts.slice(0, -1), { artifact_type: 'episode_outline', title: '分集大纲', content: null }], scenes: [] })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
})

test('a complete envelope missing only required stage documents can safely fill those targets', async () => {
  const original = body('outline').artifacts.slice(1)
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, contract, onPartial) => {
    calls++
    if (calls === 1) {
      const raw = JSON.stringify({ artifacts: original, scenes: [] })
      onPartial?.(raw); return raw
    }
    assert.equal(contract?.name, 'script_stage_blocks')
    return JSON.stringify({ blocks: [block('outline:main', '林舟调查钥匙，终局履行承诺归还。')], complete: true })
  })
  assert.equal(calls, 2)
  assert.deepEqual(draft.artifacts.slice(0, -1), original)
  assert.equal(draft.artifacts.at(-1)!.artifact_type, 'outline')
})

test('a contradictory final snapshot still fails without replacing the retained document or merging its later documents', async () => {
  const steps = createGenerationSteps(), original = artifact('outline')
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    onPartial?.(truncation([original]))
    throw new TextOutputLimitError(truncation([{ ...original, content: '林舟撕毁钥匙，从未承诺归还。' }, artifact('synopsis')]), 'length')
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_conflict')
  const value = steps.checkpoint.steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.deepEqual(value.artifacts, [original])
})

test('a malformed continuation with retained blocks resumes against those blocks instead of rewriting their ids', async () => {
  let calls = 0
  const first = block('episode:1', '第1集拿到钥匙，明确承诺归还。')
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation(body('outline').artifacts.slice(0, -1)), 'length')
    assert.equal(contract?.name, 'script_stage_blocks')
    if (calls === 2) {
      const raw = JSON.stringify({ blocks: [first], complete: '尚未完成' })
      onPartial?.(raw)
      return raw
    }
    assert.ok(!prompt.includes('【一次格式修正】'))
    assert.ok(prompt.includes(JSON.stringify(first)))
    return JSON.stringify({ blocks: [first, block('episode:2', '第2集履行承诺，交还钥匙。')], complete: true })
  })
  assert.equal(calls, 3)
  assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n第2集履行承诺，交还钥匙。')
})

test('a closed invalid scene cannot be dropped before an empty continuation marks the episode complete', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 }), steps = createGenerationSteps()
  const script = { artifact_type: 'episode_script', title: '第1集', content: '场一承诺。场二归还。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    if (calls > 1) return JSON.stringify({ blocks: [], complete: true })
    const raw = JSON.stringify({ artifacts: [script], scenes: [scene('场一'), { ...scene('场二'), duration: null }] })
    onPartial?.(raw); return raw
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
  const retained = steps.checkpoint.steps['draft:stream:state']!.value as { scenes: Array<{ heading: string }> }
  assert.deepEqual(retained.scenes.map(item => item.heading), ['场一'])
})

test('a source scene id forbidden by the operation cannot be discarded as malformed envelope metadata', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  const script = { artifact_type: 'episode_script', title: '第1集', content: '场一承诺。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    if (calls > 1) return JSON.stringify({ blocks: [], complete: true })
    const raw = JSON.stringify({ artifacts: [script], scenes: [scene('场一', 'not-allowed')], unexpected: true })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 1)
})

test('a malformed closed block after retained prose cannot be dropped before empty complete=true', async () => {
  let calls = 0
  const steps = createGenerationSteps()
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation(body('outline').artifacts.slice(0, -1)), 'length')
    if (calls > 2) return JSON.stringify({ blocks: [], complete: true })
    const raw = JSON.stringify({ blocks: [block('episode:1'), { ...block('episode:2'), content: null }], complete: true })
    onPartial?.(raw); return raw
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 2)
  const retained = steps.checkpoint.steps['draft:stream:state']!.value as { blocks: Array<{ id: string }> }
  assert.deepEqual(retained.blocks.map(item => item.id), ['episode:1'])
})

test('a well-shaped semantic block invalid for the current stage is rejected even when its envelope is damaged', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation(body('outline').artifacts.slice(0, -1)), 'length')
    if (calls > 2) return JSON.stringify({ blocks: [], complete: true })
    const raw = JSON.stringify({ blocks: [block('episode:1'), block('episode:2', '错误分场', [scene('场二')])], complete: '坏外壳' })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 2)
})

test('an invalid scene continuation cannot use previously received scenes to finish after an empty correction', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  const script = { artifact_type: 'episode_script', title: '第1集', content: '场一承诺。场二归还。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError('{"artifacts":[' + JSON.stringify(script) + '],"scenes":[' + JSON.stringify(scene('场一')) + ',{"heading":"未完', 'length')
    if (calls > 2) return JSON.stringify({ blocks: [], complete: true })
    const raw = JSON.stringify({ blocks: [{ id: 'scene:2', title: script.title, content: '', scenes: [{ ...scene('场二'), duration: null }] }], complete: true })
    onPartial?.(raw); return raw
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 2)
})

test('a cutoff before any complete document switches to semantic units without repeating the failed whole response', async () => {
  let calls = 0
  const req = workflowRequest.parse({ stage: 'characters' })
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, contract) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError('{"artifacts":[{"artifact_type":"characters","content":"未完', 'length')
    assert.equal(contract?.name, 'script_stage_blocks')
    return JSON.stringify({ blocks: [block(`part:${calls}`, `完整人物或关系正文${calls}。`)], complete: true })
  })
  assert.equal(calls, 3); assert.deepEqual(draft.artifacts.map(item => item.artifact_type), ['characters', 'relationships'])
})

test('completed units are persisted during reception and survive network failure without replaying the complete source stage', async () => {
  const store = workspace(), initial = body('outline').artifacts.slice(0, -1)
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    onPartial?.(truncation(initial))
    assert.equal((store.get().steps['draft:stream:state']!.value as { artifacts: unknown[] }).artifacts.length, 8, 'saved before the request fails')
    throw new Error('socket disconnected')
  }, { steps: store.runner() }), /socket disconnected/)
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract) => {
    calls++; assert.equal(contract?.name, 'script_stage_blocks'); assert.ok(prompt.includes(JSON.stringify(initial)))
    return JSON.stringify({ blocks: [block('episode:1')], complete: true })
  }, { steps: store.runner() })
  assert.equal(calls, 1); assert.equal(draft.artifacts.length, 9)
})

test('cancellation preserves complete received units, while incomplete strings never enter checkpoints', async () => {
  const store = workspace(), controller = new AbortController()
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    onPartial?.(truncation([artifact('outline')]))
    controller.abort(new DOMException('user stopped', 'AbortError'))
    throw controller.signal.reason
  }, { steps: store.runner(), signal: controller.signal }), /user stopped/)
  const value = store.get().steps['draft:stream:state']!.value as { artifacts: unknown[] }
  assert.equal(value.artifacts.length, 1); assert.ok(!JSON.stringify(value).includes('未写完'))
})

test('semantic block reception is saved before a later disconnection and is reused exactly once on resume', async () => {
  const store = workspace(), initial = body('outline').artifacts.slice(0, -1)
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    if (++calls === 1) throw new TextOutputLimitError(truncation(initial), 'length')
    onPartial?.('{"blocks":[' + JSON.stringify(block('episode:1', '第1集完整正文。')) + ',')
    const state = store.get().steps['draft:stream:state']!.value as { blocks: unknown[] }
    assert.equal(state.blocks.length, 1)
    throw new Error('connection lost')
  }, { steps: store.runner() }), /connection lost/)
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (prompt, contract) => {
    assert.equal(contract?.name, 'script_stage_blocks'); assert.match(prompt, /第1集完整正文/)
    return JSON.stringify({ blocks: [block('episode:1', '第1集完整正文。'), block('episode:2', '第2集完整正文。')], complete: true })
  }, { steps: store.runner() })
  assert.equal(draft.artifacts.at(-1)!.content, '第1集完整正文。\n\n第2集完整正文。')
})

test('episode continuation keeps complete script unchanged and only finishes matching scenes', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 2 })
  const script = { artifact_type: 'episode_script', title: '第2集：约定', content: '场一承诺。场二归还。' }
  let calls = 0
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (prompt, contract) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError('{"artifacts":[' + JSON.stringify(script) + '],"scenes":[' + JSON.stringify(scene('场一')) + ',{"heading":"未完', 'length')
    assert.equal(contract?.name, 'script_stage_blocks'); assert.match(prompt, /模式：scenes/); assert.ok(prompt.includes(JSON.stringify(script)))
    return JSON.stringify({ blocks: [{ id: 'scene:2', title: script.title, content: '', scenes: [scene('场二')] }], complete: true })
  })
  assert.equal(calls, 2); assert.deepEqual(draft.artifacts, [script]); assert.deepEqual(draft.scenes.map(item => item.heading), ['场一', '场二'])
})

test('episode script blocks carry synchronized scenes and final operation validation is mandatory', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1, operation: 'regenerate' })
  let calls = 0, validations = 0
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError('{"artifacts":[', 'length')
    return JSON.stringify({ blocks: [block('scene:1', '第1场承诺并交接钥匙。', [scene('场一', 'existing-scene')])], complete: true })
  }, { validate: value => { validations++; assert.equal(value.scenes[0]!.source_scene_id, 'existing-scene') } })
  assert.equal(draft.scenes.length, 1); assert.equal(validations, 1)
})

test('repeated content and repeated ids cannot accumulate, and two rounds without progress stop automatically', async () => {
  let calls = 0
  const initial = body('outline').artifacts.slice(0, -1), steps = createGenerationSteps()
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(truncation(initial), 'length')
    return JSON.stringify({ blocks: [block(`id:${calls}`, '同一份完整正文。')], complete: false })
  }, { steps }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_no_progress')
  assert.equal(calls, 4)
  const value = steps.checkpoint.steps['draft:stream:state']!.value as { blocks: unknown[] }
  assert.equal(value.blocks.length, 1)
})

test('a truncated oversized relationship unit focuses the next request and progress restores batching without rewriting complete characters', async () => {
  const req = workflowRequest.parse({ stage: 'characters' }), retained = artifact('characters'), steps = createGenerationSteps()
  const first = { ...block('relationship:林舟:阿禾:初识', '林舟将钥匙交给阿禾保管，双方从试探转为互信。'), title: '人物关系' }
  const second = { ...block('relationship:林舟:阿禾:终局', '阿禾归还钥匙，林舟履行承诺，双方成为平等盟友。'), title: first.title }
  const partial = '{"blocks":[{"id":"relationships:all","title":"人物关系","content":"未闭合关系全文'
  let calls = 0
  const progress: string[] = []
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation([retained], '{"artifact_type":"relationships","title":"人物关系","content":"未完'), 'length')
    const properties = contract!.schema.properties as Record<string, { items?: { properties?: Record<string, unknown> }; maxItems?: number }>
    const blocks = properties.blocks!
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.match(prompt, /以一对人物的关系为单元/)
    assert.ok(!prompt.includes('分集大纲以完整一集为单元'))
    assert.ok(prompt.includes(JSON.stringify(retained)))
    assert.deepEqual(blocks.items!.properties!.scenes, { description: '当前文档没有分场，必须返回空数组', type: 'array', items: { type: 'object', properties: {}, required: [], additionalProperties: false }, maxItems: 0 })
    if (calls === 2) {
      assert.equal(blocks.maxItems, 200)
      onPartial?.(partial)
      throw new TextOutputLimitError(partial, 'length')
    }
    assert.ok(!prompt.includes('未闭合关系全文'), 'a truncated string is never adopted as context or editable prose')
    if (calls === 3) {
      assert.equal(blocks.maxItems, 1)
      assert.match(prompt, /本轮至多返回一个尚未完成的最小完整语义单元/)
      return JSON.stringify({ blocks: [first], complete: false })
    }
    assert.equal(blocks.maxItems, 200, 'one successful complete unit restores batch generation')
    assert.ok(!prompt.includes('【本轮缩小输出范围】'))
    assert.ok(prompt.includes(JSON.stringify(first)))
    return JSON.stringify({ blocks: [second], complete: true })
  }, { steps, onProgress: message => progress.push(message) })
  assert.equal(calls, 4)
  assert.deepEqual(draft.artifacts[0], retained)
  assert.equal(draft.artifacts[1]!.content, first.content + '\n\n' + second.content)
  assert.ok(progress.some(message => message.includes('正缩小到一个完整小节继续')))
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('legacy v1 stalled checkpoints resume in focused mode and keep the completed character document', async () => {
  const req = workflowRequest.parse({ stage: 'characters' }), retained = artifact('characters'), store = workspace()
  let calls = 0
  const progress: string[] = []
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(truncation([retained], '{"artifact_type":"relationships","title":"人物关系","content":"未完'), 'length')
    throw new TextOutputLimitError('{"blocks":[{"id":"all","title":"人物关系","content":"未闭合', 'length')
  }, { steps: store.runner(), onProgress: message => progress.push(message) }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_no_progress')
  assert.equal(calls, 3)
  assert.match(progress.at(-1)!, /本轮接续已停止/)
  assert.doesNotMatch(progress.at(-1)!, /正在|正从|正缩小/)
  const checkpoint = store.get().steps['draft:stream:state']!.value as { version: number; noProgress: number; focused?: boolean; artifacts: unknown[] }
  assert.equal(checkpoint.version, 1); assert.equal(checkpoint.noProgress, 2)
  assert.deepEqual(checkpoint.artifacts, [retained])
  delete checkpoint.focused
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_stage_blocks', 'resuming does not restart a whole-stage response')
    assert.equal((contract!.schema.properties as Record<string, { maxItems: number }>).blocks!.maxItems, 1)
    assert.match(prompt, /【本轮缩小输出范围】/)
    assert.ok(prompt.includes(JSON.stringify(retained)))
    return JSON.stringify({ blocks: [{ ...block('relationship:林舟:阿禾', '林舟与阿禾从互相试探到归还钥匙后的平等信任。'), title: '人物关系' }], complete: true })
  }, { steps: store.runner() })
  assert.equal(calls, 4)
  assert.deepEqual(draft.artifacts[0], retained)
})

test('focused wire limits never discard multiple closed semantic units received before another output limit', async () => {
  const req = workflowRequest.parse({ stage: 'characters' }), retained = artifact('characters'), steps = createGenerationSteps()
  const first = { ...block('relationship:1', '林舟向阿禾承诺归还钥匙。'), title: '人物关系' }
  const second = { ...block('relationship:2', '林舟与守门人在调查后解除误会。'), title: first.title }
  let calls = 0
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (prompt, contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation([retained], '{"artifact_type":"relationships","title":"人物关系","content":"未完'), 'length')
    if (calls === 2) throw new TextOutputLimitError('{"blocks":[{"id":"all","title":"人物关系","content":"未完', 'length')
    if (calls === 3) {
      assert.equal((contract!.schema.properties as Record<string, { maxItems: number }>).blocks!.maxItems, 1)
      const raw = '{"blocks":[' + JSON.stringify(first) + ',' + JSON.stringify(second) + ',{"id":"relationship:3","title":"人物关系","content":"半截'
      onPartial?.(raw)
      const saved = steps.checkpoint.steps['draft:stream:state']!.value as { blocks: unknown[]; focused: boolean }
      assert.deepEqual(saved.blocks, [first, second])
      assert.equal(saved.focused, false, 'progress leaves focused mode before a later transport failure can interrupt the response')
      throw new TextOutputLimitError(raw, 'length')
    }
    assert.equal((contract!.schema.properties as Record<string, { maxItems: number }>).blocks!.maxItems, 200)
    assert.ok(prompt.includes(JSON.stringify(first))); assert.ok(prompt.includes(JSON.stringify(second)))
    assert.ok(!prompt.includes('半截'))
    return JSON.stringify({ blocks: [], complete: true })
  }, { steps })
  assert.equal(calls, 4)
  assert.deepEqual(draft.artifacts[0], retained)
  assert.equal(draft.artifacts[1]!.content, first.content + '\n\n' + second.content)
})

test('a focused block received before a disconnect resets the stalled counter before explicit resume', async () => {
  const req = workflowRequest.parse({ stage: 'characters' }), retained = artifact('characters'), store = workspace()
  const first = { ...block('relationship:1', '林舟将钥匙交给阿禾，双方建立信任。'), title: '人物关系' }
  const second = { ...block('relationship:2', '阿禾归还钥匙，双方成为平等盟友。'), title: first.title }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    if (++calls === 1) throw new TextOutputLimitError(truncation([retained], '{"artifact_type":"relationships","title":"人物关系","content":"未完'), 'length')
    if (calls === 2) throw new TextOutputLimitError('{"blocks":[{"id":"all","title":"人物关系","content":"未完', 'length')
    onPartial?.('{"blocks":[' + JSON.stringify(first) + ',{"id":"next","content":"未完')
    throw new TextProviderError('socket reset after a complete focused block', true)
  }, { steps: store.runner() }), (error: unknown) => (error as { code: string }).code === 'stage_stream_interrupted')
  const state = store.get().steps['draft:stream:state']!.value as { noProgress: number; focused: boolean; blocks: unknown[] }
  assert.equal(state.noProgress, 0, 'new complete content clears the old stall before a terminal response')
  assert.equal(state.focused, false)
  assert.deepEqual(state.blocks, [first])
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (prompt, contract) => {
    calls++
    assert.equal(contract?.name, 'script_stage_blocks')
    assert.equal((contract!.schema.properties as Record<string, { maxItems: number }>).blocks!.maxItems, 200)
    assert.ok(prompt.includes(JSON.stringify(first)))
    return JSON.stringify({ blocks: [second], complete: true })
  }, { steps: store.runner() })
  assert.equal(calls, 4)
  assert.deepEqual(draft.artifacts[0], retained)
  assert.equal(draft.artifacts[1]!.content, first.content + '\n\n' + second.content)
})

test('conflicting content for an accepted semantic id fails instead of replacing previously received prose', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(truncation(body('outline').artifacts.slice(0, -1)), 'length')
    return JSON.stringify({ blocks: [block('episode:1', calls === 2 ? '第一次完整剧情。' : '冲突改写剧情。')], complete: false })
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_conflict')
  assert.equal(calls, 3)
})

test('each automatic continuation is bounded and explicit resume keeps completed units with a fresh finite budget', async () => {
  const store = workspace(); let calls = 0
  const generator: StageStreamGenerator = async () => {
    if (++calls === 1) throw new TextOutputLimitError(truncation(body('outline').artifacts.slice(0, -1)), 'length')
    return JSON.stringify({ blocks: [block(`episode:${calls}`)], complete: false })
  }
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, generator, { steps: store.runner(), maxRounds: 3 }), /轮次上限/)
  assert.equal(calls, 3)
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, generator, { steps: store.runner(), maxRounds: 3 }), /轮次上限/)
  assert.equal(calls, 6)
})

test('a changed creator prompt invalidates partial checkpoints and begins one new whole-stage request', async () => {
  const store = workspace()
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    onPartial?.(truncation([artifact('outline')])); throw new Error('connection lost')
  }, { steps: store.runner() }))
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt + '改成写实风格。', async (_prompt, contract) => {
    assert.equal(contract?.name, 'workflow_draft'); return JSON.stringify(body('outline'))
  }, { steps: store.runner() })
  assert.equal(draft.artifacts.length, 9)
})

test('the final permitted response can finish the stage and business validation errors are never saved as a complete draft', async () => {
  let calls = 0
  const initial = body('outline').artifacts.slice(0, -1)
  const generator: StageStreamGenerator = async () => {
    if (++calls === 1) throw new TextOutputLimitError(truncation(initial), 'length')
    return JSON.stringify({ blocks: [block('episode:1')], complete: true })
  }
  assert.equal((await generateStageDraftWithContinuation(request, sourcePrompt, generator, { maxRounds: 2 })).artifacts.length, 9)
  calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, generator, { validate: () => { throw new Error('existing scene preservation failed') } }), /existing scene preservation failed/)
})

test('an invalid complete block cannot be ignored before trusting complete=true', async () => {
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(workflowRequest.parse({ stage: 'characters' }), sourcePrompt, async () => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(truncation([artifact('relationships')], '{"artifact_type":"characters","content":"未完'), 'length')
    return JSON.stringify({ blocks: [block(`character:${calls}`, calls === 2 ? '人物开头。' : '非法场次段。', calls === 2 ? [] : [scene('不应出现在人物阶段')])], complete: calls > 2 })
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_invalid_unit')
  assert.equal(calls, 3)
})

test('filtered terminal responses discard their progressive units and cannot be resumed as an accepted candidate', async () => {
  const store = workspace()
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    onPartial?.(truncation([artifact('outline')]))
    throw new TextProviderError('content filtered', false, 'content_filter')
  }, { steps: store.runner() }), /content filtered/)
  assert.deepEqual(store.get().steps, {})
  let calls = 0
  await generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, contract) => {
    calls++; assert.equal(contract?.name, 'workflow_draft'); return JSON.stringify(body('outline'))
  }, { steps: store.runner() })
  assert.equal(calls, 1)
})

test('a transient network failure after complete units does not reissue the original whole-stage request', async () => {
  const store = workspace(); let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, _contract, onPartial) => {
    calls++; onPartial?.(truncation(body('outline').artifacts.slice(0, -1)))
    throw new TextProviderError('socket reset', true)
  }, { steps: store.runner() }), /socket reset/)
  assert.equal(calls, 1)
  const draft = await generateStageDraftWithContinuation(request, sourcePrompt, async (_prompt, contract) => {
    assert.equal(contract?.name, 'script_stage_blocks'); return JSON.stringify({ blocks: [block('episode:1')], complete: true })
  }, { steps: store.runner() })
  assert.equal(draft.artifacts.length, 9)
})

test('strict-wire nullable optional scene fields survive progressive recovery and semantic continuation', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  const original = { artifact_type: 'episode_script', title: '第1集', content: '第1场拿到钥匙，第2场承诺归还。' }
  const wireScene = (heading: string) => ({ heading, source_scene_id: null, location: null, time_of_day: null,
    characters: null, action: null, dialogue: null, narration: null, duration: 10 })
  let calls = 0
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    if (++calls === 1) {
      const raw = '{"artifacts":[' + JSON.stringify(original) + '],"scenes":[' + JSON.stringify(wireScene('场一')) + ',{"heading":"未完'
      onPartial?.(raw); throw new TextOutputLimitError(raw, 'length')
    }
    const raw = '{"blocks":[' + JSON.stringify({ id: 'scene:2', title: '第1集', content: '', scenes: [wireScene('场二')] }) + ',{"id":"未完'
    if (calls === 2) { onPartial?.(raw); throw new TextOutputLimitError(raw, 'length') }
    return JSON.stringify({ blocks: [], complete: true })
  })
  assert.equal(calls, 3); assert.deepEqual(draft.scenes.map(item => item.heading), ['场一', '场二'])
  assert.equal(draft.scenes[0]!.source_scene_id, undefined); assert.equal(draft.scenes[1]!.location, '')
})

test('scene-first truncated envelopes cannot silently drop previously received scenes when rebuilding episode prose', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError('{"scenes":[' + JSON.stringify(scene('场一')) + '],"artifacts":[{"artifact_type":"episode_script","content":"未完', 'length')
    return JSON.stringify({ blocks: [block('scene:2', '场二交还钥匙。', [scene('场二')])], complete: true })
  }), (error: unknown) => (error as { code: string }).code === 'stage_continuation_missing_scene')
  assert.equal(calls, 2)
})

test('covering 51 received scenes in rebuilt prose does not double-count capacity or change their order', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1, operation: 'regenerate' })
  const originalScenes = Array.from({ length: 51 }, (_, index) => scene(`场${index + 1}`, `source:${index + 1}`))
  let calls = 0
  const draft = await generateStageDraftWithContinuation(req, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError('{"scenes":' + JSON.stringify(originalScenes) + ',"artifacts":[{"artifact_type":"episode_script","content":"未完', 'length')
    return JSON.stringify({ blocks: originalScenes.map((item, index) => block(`scene:${index + 1}`, `第${index + 1}场完整正文。`, [item])), complete: true })
  })
  assert.equal(calls, 2); assert.deepEqual(draft.scenes, originalScenes)
})

test('nullable required scene fields remain invalid and cannot produce a completed candidate', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 })
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError('{"artifacts":[', 'length')
    return JSON.stringify({ blocks: [block('scene:1', '完整正文。', [{ ...scene('场一'), duration: null }])], complete: true })
  }), /契约/)
  assert.equal(calls, 3, 'one bounded schema correction, then failure')
})

test('scene recovery never skips an invalid middle scene and keeps later scenes as a false contiguous prefix', async () => {
  const req = workflowRequest.parse({ stage: 'episode', episode_number: 1 }), steps = createGenerationSteps()
  await assert.rejects(generateStageDraftWithContinuation(req, sourcePrompt, async (_prompt, _contract, onPartial) => {
    const raw = '{"scenes":[' + [scene('场一'), { ...scene('场二'), duration: null }, scene('场三')].map(item => JSON.stringify(item)).join(',') + '],"artifacts":['
    onPartial?.(raw); throw new Error('connection lost')
  }, { steps }), /connection lost/)
  assert.deepEqual((steps.checkpoint.steps['draft:stream:state']!.value as { scenes: Array<{ heading: string }> }).scenes.map(item => item.heading), ['场一'])
})
