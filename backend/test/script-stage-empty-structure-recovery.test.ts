import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, stageContinuationStateSchema } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'props', intent: 'stage_design', artifact_types: ['prop_functions'] })
const prompt = '完整原稿：铜钥匙只开启旧库房，铁灯只能照亮道路；沿用原规则，不增加新力量。'
const block = (id: string) => ({ id, title: '剧情功能与使用规则', content: `${id}的完整触发条件、使用限制及剧情作用。`, scenes: [] })
const originals = Array.from({ length: 12 }, (_, index) => block(`prop:${index}`))
const next = block('prop:new'), missingScenes = { id: next.id, title: next.title, content: next.content }
const page = (blocks: unknown[], complete = true, extra = {}) => JSON.stringify({ blocks, complete, ...extra })
const fixed = (repairs: unknown[], empty_units: unknown[]) => JSON.stringify({ repairs, empty_units })
const metadata = { candidate_id: 'block:0', id: next.id, title: next.title, add_empty_scenes: true, removed_fields: [] }
const acknowledge = (index = 1) => ({ candidate_id: `block:${index}`, disposition: 'discard_empty_structure' })
function store(initialBlocks = originals) {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  steps().retain('draft:stream:state', '保留剧情功能与使用规则', { strategy: 'stage-semantic-stream-v1', request, prompt }, {
    version: 1, round: 10, initialEnded: true, artifacts: [], scenes: [], target: 'prop_functions', mode: 'document', blocks: initialBlocks, noProgress: 0,
  }, value => stageContinuationStateSchema.parse(value))
  return { steps, state: () => stageContinuationStateSchema.parse(checkpoint.steps['draft:stream:state']!.value), saved: () => structuredClone(checkpoint) }
}

test('the diagnostic-equivalent mixed page repairs metadata and explicitly confirms an empty structure, then requires another completion', async () => {
  const f = store(), suffix = block('prop:suffix')
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
    calls++
    if (calls === 1) return page([missingScenes, { scenes: [] }, suffix])
    if (calls === 2) {
      assert.equal(contract?.name, 'script_stage_block_repair')
      assert.deepEqual(f.state().blocks, originals)
      assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [missingScenes, { scenes: [] }, suffix])
      assert.equal(f.state().pendingBlockResponse!.diagnostics.length, 4, 'matches all four persisted issue paths from the actual failed task')
      assert.ok(!text.includes(prompt), 'pure structure repair does not resend the manuscript')
      return fixed([metadata], [acknowledge()])
    }
    assert.equal(calls, 3); assert.equal(contract?.name, 'script_stage_blocks')
    assert.ok(text.includes(prompt)); assert.match(text, /空结构纠正/)
    assert.deepEqual(f.state().blocks, [...originals, next, suffix])
    assert.equal(f.state().pendingBlockResponse, null)
    assert.deepEqual(f.state().blockStructureCorrections.map(({ unit_index, target, original, disposition }) => ({ unit_index, target, original, disposition })),
      [{ unit_index: 1, target: 'prop_functions', original: { scenes: [] }, disposition: 'discard_empty_structure' }])
    return page([])
  }, { steps: f.steps() })
  assert.equal(calls, 3)
  assert.equal(draft.artifacts[0]!.content, [...originals, next, suffix].map(item => item.content).join('\n\n'))
  assert.equal(f.saved().steps['draft:stream:state'], undefined)
})

test('an empty-only page never supplies content or completes the document', async () => {
  const f = store([])
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return page([{ scenes: [] }])
    if (calls === 2) {
      assert.equal(contract?.name, 'script_stage_block_repair')
      return fixed([], [acknowledge(0)])
    }
    assert.equal(calls, 3); assert.equal(contract?.name, 'script_stage_blocks')
    assert.deepEqual(f.state().blocks, []); assert.equal(f.state().artifacts.length, 0)
    return page([next])
  }, { steps: f.steps() })
  assert.equal(calls, 3); assert.equal(draft.artifacts[0]!.content, next.content)
})

test('failed empty acknowledgement preserves every raw item and explicit resume starts the patch again', async () => {
  const f = store(), originalPage = [missingScenes, { scenes: [] }]
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) return page(originalPage)
    return fixed([metadata], [])
  }, { steps: f.steps() }), { code: 'stage_block_repair_invalid' })
  assert.equal(calls, 2); assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, originalPage)
  assert.deepEqual(f.state().blocks, originals); assert.deepEqual(f.state().blockStructureCorrections, [])
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    if (++calls === 3) {
      assert.equal(contract?.name, 'script_stage_block_repair')
      return fixed([metadata], [acknowledge()])
    }
    assert.equal(calls, 4); assert.equal(contract?.name, 'script_stage_blocks')
    return page([])
  }, { steps: f.steps() })
  assert.equal(draft.artifacts[0]!.content, [...originals, next].map(item => item.content).join('\n\n'))
})

test('disconnect after correction preserves the audit and resume cannot reuse the discarded page completion flag', async () => {
  const f = store()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    calls++
    if (calls === 1) return page([missingScenes, { scenes: [] }])
    if (calls === 2) return fixed([metadata], [acknowledge()])
    throw new TextProviderError('upstream disconnected', false, 'bad_response_body')
  }, { steps: f.steps() }), { upstreamCode: 'bad_response_body' })
  assert.equal(calls, 3); assert.equal(f.state().artifacts.length, 0)
  assert.equal(f.state().blockStructureCorrections.length, 1); assert.equal(f.state().pendingBlockResponse, null)
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++; assert.equal(contract?.name, 'script_stage_blocks'); return page([])
  }, { steps: f.steps() })
  assert.equal(calls, 4); assert.equal(draft.artifacts[0]!.content, [...originals, next].map(item => item.content).join('\n\n'))
})

test('nonempty scenes, identity, missing prose and unknown creative fields cannot be discarded as an empty structure', async t => {
  for (const invalid of [
    { scenes: [{ heading: '旧库房', action: '开启房门。', duration: 8 }] },
    { id: 'unwritten', title: next.title, scenes: [] },
    { scenes: [], notes: '铜钥匙与铁灯之间还有完整剧情关系。' },
    { scenes: [], content: '' },
    {},
  ]) await t.test(JSON.stringify(Object.keys(invalid)), async () => {
    const f = store()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      calls++; return page([missingScenes, invalid])
    }, { steps: f.steps() }), (error: unknown) => {
      const issue = error as Error & { code: string; diagnostic: { fields: string[] } }
      assert.equal(issue.code, 'stage_continuation_invalid_unit')
      assert.match(issue.message, /第2个返回项缺少完整正文/)
      assert.ok(!issue.message.includes('expected string'), 'the readable error identifies the full blocker rather than the first two schema paths')
      assert.ok(issue.diagnostic.fields.some(item => item.includes('content')))
      return true
    })
    assert.equal(calls, 1); assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [missingScenes, invalid])
    assert.deepEqual(f.state().blocks, originals)
  })
})

test('filter and cancellation during mixed structure repair retain a clean page with no adopted audit', async t => {
  for (const kind of ['filter', 'cancel']) await t.test(kind, async () => {
    const f = store(), controller = new AbortController()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      if (++calls === 1) return page([missingScenes, { scenes: [] }])
      if (kind === 'filter') throw new TextProviderError('filtered patch', false, 'content_filter')
      controller.abort(); controller.signal.throwIfAborted(); return ''
    }, { steps: f.steps(), signal: controller.signal }))
    assert.equal(calls, 2); assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [missingScenes, { scenes: [] }])
    assert.deepEqual(f.state().blocks, originals); assert.deepEqual(f.state().blockStructureCorrections, [])
  })
})

test('repeated mixed pages cannot turn empty audit entries into semantic progress or an unbounded repair loop', async () => {
  const f = store()
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (contract?.name === 'script_stage_block_repair') return fixed([metadata], [acknowledge()])
    return page([missingScenes, { scenes: [] }])
  }, { steps: f.steps() }), { code: 'stage_continuation_invalid_unit' })
  assert.equal(calls, 3); assert.equal(f.state().blockStructureCorrections.length, 1)
  assert.deepEqual(f.state().blocks, [...originals, next]); assert.ok(f.state().pendingBlockResponse)
})

test('empty structure confirmation cannot resolve same-ID content conflicts or acknowledge wrong hashes', async () => {
  const f = store(), changed = { ...originals[0]!, content: '铜钥匙现在可以打开所有房门，改写原有规则。' }
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return page([changed, { scenes: [] }])
    if (calls === 2) {
      assert.equal(contract?.name, 'script_stage_block_repair')
      return fixed([], [acknowledge()])
    }
    assert.equal(calls, 3); assert.equal(f.state().blockConflicts[0]!.occurrences, 1)
    assert.ok(!f.state().blockConflicts[0]!.resolved)
    return page([], true, { resolved_conflicts: f.state().blockConflicts.map(({ id, rejected_hash }) => ({ id, rejected_hash })) })
  }, { steps: f.steps() })
  assert.equal(calls, 3); assert.equal(draft.artifacts[0]!.content, originals.map(item => item.content).join('\n\n'))
})
