import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, stageContinuationStateSchema } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'outline' })
const prompt = '完整原稿：主角开场拿到铜钥匙，最后归还。作者要求完整整理全部事件，不虚构集数。'
const artifact = (artifact_type: string) => ({ artifact_type, title: artifact_type, content: artifact_type + '完整内容。' })
const originals = scriptStageArtifacts.outline.slice(0, -1).map(artifact)
const block = (id: string, content: string) => ({ id, title: '分集大纲', content, scenes: [] })
const first = block('opening', '开场拿到铜钥匙。')
const second = block('ending', '最后归还铜钥匙。')
const changed = { ...first, content: '冲突改写：主角从未拿到铜钥匙。' }
const initial = '{"artifacts":' + JSON.stringify(originals) + ',"scenes":[],"unfinished":"'
const response = (blocks: unknown[], complete = false, resolved_conflicts?: unknown[]) => JSON.stringify({ blocks, complete, ...(resolved_conflicts ? { resolved_conflicts } : {}) })
function store() {
  let saved: GenerationCheckpoint = { steps: {} }
  return { steps: () => createGenerationSteps({ checkpoint: saved, save: state => { saved = structuredClone(state) } }),
    snapshot: () => structuredClone(saved), state: () => stageContinuationStateSchema.parse(saved.steps['draft:stream:state']!.value),
    restore: (value: GenerationCheckpoint) => { saved = structuredClone(value) } }
}
const acknowledgements = (f: ReturnType<typeof store>) => f.state().blockConflicts.filter(item => !item.resolved).map(({ id, rejected_hash }) => ({ id, rejected_hash }))
const conflictError = (issue: unknown) => (issue as { code?: string }).code === 'stage_continuation_conflict'

test('nonretryable initial provider failures preserve streamed complete artifacts and resume only missing content', async t => {
  for (const code of ['bad_response_body', 'invalid_api_key']) await t.test(code, async () => {
    const f = store(), failure = new TextProviderError('upstream ' + code, false, code)
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
      onPartial?.(initial); throw failure
    }, { steps: f.steps() }), issue => issue === failure)
    assert.deepEqual(f.state().artifacts, originals)
    let calls = 0
    const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
      calls++; assert.equal(contract?.name, 'script_stage_blocks'); assert.ok(text.includes(prompt))
      assert.ok(text.includes(JSON.stringify(originals))); return response([first, second], true)
    }, { steps: f.steps() })
    assert.equal(calls, 1); assert.deepEqual(draft.artifacts.slice(0, -1), originals)
  })
})

test('nonretryable continuation failure preserves accepted blocks and retains the exact upstream error', async () => {
  const f = store(), failure = new TextProviderError('bad body', false, 'bad_response_body')
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    onPartial?.(response([first])); throw failure
  }, { steps: f.steps() }), issue => issue === failure)
  assert.deepEqual(f.state().blocks, [first]); assert.deepEqual(f.state().artifacts, originals)
  const draft = await generateStageDraftWithContinuation(request, prompt, async text => {
    assert.ok(text.includes(JSON.stringify(first))); return response([second], true)
  }, { steps: f.steps() })
  assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
})

test('a conflicting page preserves immutable original and later legal blocks, discards its complete flag and corrects once', async () => {
  const f = store(); let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract, onPartial) => {
    calls++
    if (calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) { const raw = response([changed, second], true); onPartial?.(raw); onPartial?.(raw); return raw }
    assert.equal(calls, 4); assert.ok(text.includes(prompt)); assert.match(text, /已保留单元冲突纠正/)
    assert.ok(text.includes(JSON.stringify(first))); assert.ok(text.includes(JSON.stringify(second)))
    assert.ok(text.includes(changed.content)); assert.equal(f.state().blocks[0]!.content, first.content)
    assert.equal(f.state().blocks.length, 2)
    assert.equal(f.state().blockConflicts[0]!.occurrences, 1, 'cumulative and terminal reads count one rejected candidate per response')
    assert.match(text, /仅返回blocks、complete和resolved_conflicts/)
    assert.ok(!text.includes('仅返回blocks和complete。'))
    assert.ok('resolved_conflicts' in (contract!.schema.properties as object))
    return response([], true, acknowledgements(f))
  }, { steps: f.steps() })
  assert.equal(calls, 4); assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
  assert.ok(!draft.artifacts.at(-1)!.content.includes(changed.content))
})

test('conflicting completed final unit can be acknowledged without inventing another unit', async () => {
  const f = store(); let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) return response([changed], true)
    return response([], true, acknowledgements(f))
  }, { steps: f.steps() })
  assert.equal(calls, 4); assert.equal(draft.artifacts.at(-1)!.content, first.content)
})

test('repeated conflicts stop after one correction and the persisted diagnostic changes the next explicit resume', async () => {
  const f = store(); let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    return response([calls === 2 ? first : changed], false)
  }, { steps: f.steps() }), conflictError)
  assert.equal(calls, 4); assert.deepEqual(f.state().blocks, [first]); assert.equal(f.state().blockConflicts.length, 1)
  const before = f.state().blockConflicts[0]!
  assert.ok(before.rejected_preview.includes(changed.content)); assert.equal(before.resolved, false)
  const draft = await generateStageDraftWithContinuation(request, prompt, async text => {
    assert.match(text, /已保留单元冲突纠正/); assert.ok(text.includes(before.rejected_hash))
    return response([second], true, acknowledgements(f))
  }, { steps: f.steps() })
  assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
})

test('an empty completion without the exact conflict acknowledgement cannot bypass the rejected page', async () => {
  const f = store(); let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) return response([changed], true)
    return response([], true, [{ id: first.id, rejected_hash: '0'.repeat(64) }])
  }, { steps: f.steps() }), conflictError)
  assert.equal(calls, 4); assert.deepEqual(f.state().blocks, [first]); assert.equal(f.state().blockConflicts[0]!.resolved, false)
})

test('rejected bodies cannot return under new IDs, including resolved and superseded conflicts', async () => {
  const f = store(), changedAgain = { ...changed, content: '另一份冲突改写：铜钥匙从未存在。' }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async text => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) return response([changed])
    if (calls === 4) return response([second], false, acknowledgements(f))
    if (calls === 5) {
      assert.equal(f.state().blockConflicts[0]!.resolved, true)
      assert.ok(!text.includes('resolved_conflicts必须'))
      assert.match(text, /仅返回blocks和complete。/)
      return response([changedAgain])
    }
    assert.equal(calls, 6)
    return response([{ ...changed, id: 'renamed-rejected-prose', title: '另一个标题' }], true, acknowledgements(f))
  }, { steps: f.steps() }), conflictError)
  assert.equal(calls, 6); assert.deepEqual(f.state().blocks, [first, second])
  assert.equal(f.state().blockConflicts[0]!.rejected_fingerprints.length, 3)
  assert.equal(f.state().blockConflicts[0]!.occurrences, 3)
  assert.equal(f.state().blockConflicts[0]!.resolved, false)
})

test('legacy conflict hashes block exact renamed rejected bodies even when the preview was truncated', async () => {
  const f = store(), disconnected = new TextProviderError('correction disconnected', false, 'bad_response_body')
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) return response([changed])
    throw disconnected
  }, { steps: f.steps() }), issue => issue === disconnected)
  const saved = f.snapshot()
  const diagnostic = (saved.steps['draft:stream:state']!.value as { blockConflicts: { rejected_fingerprints?: unknown; rejected_preview: string }[] }).blockConflicts[0]!
  delete diagnostic.rejected_fingerprints; diagnostic.rejected_preview = '{"truncated'
  f.restore(saved); calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) return response([{ ...changed, id: 'new-id', title: '新标题' }], true, acknowledgements(f))
    assert.equal(f.state().blocks.length, 1)
    return response([second], true, acknowledgements(f))
  }, { steps: f.steps() })
  assert.equal(calls, 2); assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
})

test('conflict fingerprint capacity stops safely while preserving accepted prose and prior diagnostics', async () => {
  const f = store(), disconnected = new TextProviderError('correction disconnected', false, 'bad_response_body')
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    if (calls === 2) return response([first])
    if (calls === 3) return response([changed])
    throw disconnected
  }, { steps: f.steps() }), issue => issue === disconnected)
  const saved = f.snapshot(), state = stageContinuationStateSchema.parse(saved.steps['draft:stream:state']!.value)
  const conflict = state.blockConflicts[0]!
  conflict.rejected_fingerprints.push(...Array.from({ length: 999 }, (_, index) => ({ block_hash: index.toString(16).padStart(64, '0') })))
  saved.steps['draft:stream:state']!.value = state; f.restore(saved)
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => response([{ ...changed, content: '新冲突候选。' }]), { steps: f.steps() }),
    issue => (issue as { code?: string }).code === 'stage_continuation_capacity')
  assert.deepEqual(f.state().blocks, [first]); assert.deepEqual(f.state().blockConflicts, state.blockConflicts)
})

test('content filtering discards only the current response and preserves earlier accepted work', async t => {
  await t.test('first filtered response leaves no accepted checkpoint', async () => {
    const f = store(), filtered = new TextProviderError('content filtered', false, 'content_filter')
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
      onPartial?.(initial); throw filtered
    }, { steps: f.steps() }), issue => issue === filtered)
    assert.equal(f.snapshot().steps['draft:stream:state'], undefined)
  })
  await t.test('later filtered correction rolls back its new prose and diagnostic changes', async () => {
    const f = store(), filtered = new TextProviderError('content filtered', false, 'content_filter')
    let calls = 0, originalHash = ''
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
      if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
      if (calls === 2) return response([first])
      if (calls === 3) return response([changed])
      originalHash = f.state().blockConflicts[0]!.rejected_hash
      onPartial?.(response([{ ...changed, content: '本响应被过滤的冲突候选。' }, second], true, acknowledgements(f)))
      throw filtered
    }, { steps: f.steps() }), issue => issue === filtered)
    assert.deepEqual(f.state().artifacts, originals); assert.deepEqual(f.state().blocks, [first])
    assert.equal(f.state().blockConflicts[0]!.rejected_hash, originalHash)
    assert.equal(f.state().blockConflicts[0]!.occurrences, 1)
    assert.equal(f.state().blockConflicts[0]!.rejected_fingerprints.length, 1)
    const draft = await generateStageDraftWithContinuation(request, prompt, async () => response([second], true, acknowledgements(f)), { steps: f.steps() })
    assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
  })
})

test('a disconnect or cancellation during correction retains diagnostics and accepted prose', async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? 'cancel' : 'disconnect', async () => {
    const f = store(), controller = new AbortController(), failure = cancelled ? new Error('creator stopped') : new TextProviderError('bad body', false, 'bad_response_body')
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
      if (calls === 2) return response([first])
      if (calls === 3) return response([changed], true)
      if (cancelled) controller.abort(failure)
      throw failure
    }, { steps: f.steps(), signal: controller.signal }), issue => issue === failure)
    assert.equal(calls, 4); assert.deepEqual(f.state().blocks, [first]); assert.equal(f.state().blockConflicts.length, 1)
  })
})

test('old v1 checkpoints without conflict metadata and title-only variations remain compatible', async () => {
  const f = store(); let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) throw new TextOutputLimitError(initial, 'length')
    return response([first])
  }, { steps: f.steps(), maxRounds: 2 }), /轮次上限/)
  const saved = f.snapshot(); delete (saved.steps['draft:stream:state']!.value as { blockConflicts?: unknown }).blockConflicts; f.restore(saved)
  const draft = await generateStageDraftWithContinuation(request, prompt, async () => response([{ ...first, title: '另一个展示标题' }, second], true), { steps: f.steps() })
  assert.equal(draft.artifacts.at(-1)!.title, first.title)
  assert.equal(draft.artifacts.at(-1)!.content, first.content + '\n\n' + second.content)
})
