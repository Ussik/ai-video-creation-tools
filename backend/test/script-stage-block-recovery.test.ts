import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { generateStageDraftWithContinuation, stageContinuationStateSchema } from '../src/modules/script/script-stage-continuation.js'
import { workflowRequest } from '../src/modules/script/script-workflow.js'

const request = workflowRequest.parse({ stage: 'locations', intent: 'stage_design', artifact_types: ['location_layouts'] })
const prompt = '全部创作原稿及要求。'.repeat(1000)
const block = (id: string, content = `${id}的完整空间关系及行动路线。`) => ({ id, title: '空间与动线', content, scenes: [] })
const originals = Array.from({ length: 7 }, (_, index) => block(`accepted:${index}`))
const page = (blocks: unknown[], complete: unknown = true, extras = {}) => JSON.stringify({ blocks, complete, ...extras })
const patch = (candidate_id: string, original: ReturnType<typeof block>, extras = {}) => ({ candidate_id, id: original.id,
  title: original.title, add_empty_scenes: false, removed_fields: [], ...extras })
const repair = (...repairs: unknown[]) => JSON.stringify({ repairs })
function store(initialBlocks = originals) {
  let saved: GenerationCheckpoint = { steps: {} }
  const steps = () => createGenerationSteps({ checkpoint: saved, save: checkpoint => { saved = structuredClone(checkpoint) } })
  steps().retain('draft:stream:state', '已保留的空间设计', { strategy: 'stage-semantic-stream-v1', request, prompt },
    { version: 1, round: 10, initialEnded: true, artifacts: [], scenes: [], target: 'location_layouts', mode: 'document',
      blocks: initialBlocks, noProgress: 0 }, value => stageContinuationStateSchema.parse(value))
  return { steps, state: () => stageContinuationStateSchema.parse(saved.steps['draft:stream:state']!.value),
    saved: () => structuredClone(saved) }
}

test('closed metadata errors repair once, preserve seven existing blocks and keep the entire page in order', async t => {
  for (const kind of ['missing-scenes', 'null-scenes', 'extra-metadata']) await t.test(kind, async () => {
    const f = store(), first = block('prefix'), bad = block('pending', '  完整待修正文，标点与空白均需保留。  '), last = block('suffix')
    const malformed: Record<string, unknown> = { ...bad }
    if (kind === 'missing-scenes') delete malformed.scenes
    else if (kind === 'null-scenes') malformed.scenes = null
    else malformed.artifact_type = 'location_layouts'
    let calls = 0
    const draft = await generateStageDraftWithContinuation(request, prompt, async (text, contract) => {
      if (++calls === 1) return page([first, malformed, last])
      assert.equal(calls, 2); assert.equal(contract?.name, 'script_stage_block_repair')
      assert.ok(!text.includes(prompt), 'metadata repair does not resend the full manuscript')
      assert.deepEqual(f.state().blocks, [...originals, first])
      assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [first, malformed, last])
      assert.ok(text.includes(bad.content)); assert.ok(!text.includes(originals[0]!.content))
      const fields = (contract!.schema.properties as Record<string, { items: { properties: object } }>).repairs!.items.properties
      assert.ok(!('content' in fields) && !('scenes' in fields), 'the repair response cannot rewrite prose')
      return repair(patch('block:1', bad, { add_empty_scenes: kind !== 'extra-metadata',
        removed_fields: kind === 'extra-metadata' ? ['artifact_type'] : [] }))
    }, { steps: f.steps() })
    assert.equal(calls, 2)
    assert.equal(draft.artifacts[0]!.content, [...originals, first, bad, last].map(item => item.content.trim()).join('\n\n'))
    assert.equal(f.saved().steps['draft:stream:state'], undefined)
  })
})

test('failed metadata repair retains raw page and prefix; explicit resume repairs before generating anything else', async () => {
  const f = store(), first = block('prefix'), bad = block('pending'), last = block('suffix')
  const malformed = { ...bad, scenes: null }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    if (++calls === 1) return page([first, malformed, last])
    assert.equal(contract?.name, 'script_stage_block_repair')
    return repair(patch('block:1', bad, { add_empty_scenes: true, content: '不允许改写' }))
  }, { steps: f.steps() }), { code: 'stage_block_repair_invalid' })
  assert.equal(calls, 2)
  const before = f.state()
  assert.deepEqual(before.blocks, [...originals, first])
  assert.deepEqual(before.pendingBlockResponse!.value.blocks, [first, malformed, last])
  assert.ok(before.pendingBlockResponse!.diagnostics.some(message => message.includes('scenes')))
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++; assert.equal(contract?.name, 'script_stage_block_repair')
    return repair(patch('block:1', bad, { add_empty_scenes: true }))
  }, { steps: f.steps() })
  assert.equal(calls, 3)
  assert.equal(draft.artifacts[0]!.content, [...originals, first, bad, last].map(item => item.content).join('\n\n'))
})

test('unrepairable units preserve a nonstreamed valid prefix and all raw suffixes without a request loop', async t => {
  for (const invalid of [
    { ...block('bad'), content: '' },
    { ...block('bad'), notes: '未知创作信息，不能删除后采用。' },
    { ...block('bad'), scenes: [{ heading: '南门', action: '进入。', duration: 8 }] },
  ]) await t.test(JSON.stringify(Object.keys(invalid)), async () => {
    const f = store(), first = block('prefix'), last = block('suffix')
    let calls = 0
    const run = () => generateStageDraftWithContinuation(request, prompt, async () => {
      calls++; return page([first, invalid, last])
    }, { steps: f.steps() })
    await assert.rejects(run(), { code: 'stage_continuation_invalid_unit' })
    assert.equal(calls, 1); assert.deepEqual(f.state().blocks, [...originals, first])
    assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [first, invalid, last])
    await assert.rejects(run(), { code: 'stage_continuation_invalid_unit' })
    assert.equal(calls, 1, 'resume never skips an unrepairable quarantined page')
  })
})

test('repair completion still requires a valid complete envelope; malformed or truncated outer fields need another round', async t => {
  for (const kind of ['missing-complete', 'invalid-complete', 'outer-field', 'truncated']) await t.test(kind, async () => {
    const f = store(), bad = block('pending'), malformed = { ...bad, scenes: null }
    let calls = 0
    const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
      calls++
      if (calls === 1) {
        if (kind === 'missing-complete') return JSON.stringify({ blocks: [malformed] })
        if (kind === 'invalid-complete') return page([malformed], 'true')
        if (kind === 'outer-field') return page([malformed], true, { unsafe_extra: true })
        throw new TextOutputLimitError('{"blocks":[' + JSON.stringify(malformed) + '],"unfinished":"', 'length')
      }
      if (calls === 2) {
        assert.equal(contract?.name, 'script_stage_block_repair')
        return repair(patch('block:0', bad, { add_empty_scenes: true }))
      }
      assert.equal(calls, 3); assert.equal(contract?.name, 'script_stage_blocks')
      assert.deepEqual(f.state().blocks, [...originals, bad]); assert.equal(f.state().pendingBlockResponse, null)
      return page([])
    }, { steps: f.steps() })
    assert.equal(calls, 3); assert.equal(draft.artifacts[0]!.content, [...originals, bad].map(item => item.content).join('\n\n'))
  })
})

test('content filter and cancellation during metadata repair retain clean pending-only and existing work', async t => {
  for (const existing of [[], originals]) for (const kind of ['content-filter', 'cancel']) await t.test(`${existing.length}/${kind}`, async () => {
    const f = store(existing), bad = block('pending'), malformed = { ...bad, scenes: null }, controller = new AbortController()
    let calls = 0
    await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
      if (++calls === 1) return page([malformed])
      if (kind === 'content-filter') throw new TextProviderError('filtered patch', false, 'content_filter')
      controller.abort(); controller.signal.throwIfAborted(); return ''
    }, { steps: f.steps(), signal: controller.signal }))
    assert.equal(calls, 2); assert.deepEqual(f.state().blocks, existing)
    assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [malformed])
    const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
      assert.equal(contract?.name, 'script_stage_block_repair')
      return repair(patch('block:0', bad, { add_empty_scenes: true }))
    }, { steps: f.steps() })
    assert.equal(draft.artifacts[0]!.content, [...existing, bad].map(item => item.content).join('\n\n'))
  })
})

test('filtering the creative response rolls back its prefix before a pending repair can be adopted', async () => {
  const f = store(), first = block('prefix'), bad = { ...block('pending'), scenes: null }
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, _contract, onPartial) => {
    onPartial?.(page([first, bad])); throw new TextProviderError('filtered body', false, 'content_filter')
  }, { steps: f.steps() }), { upstreamCode: 'content_filter' })
  assert.deepEqual(f.state().blocks, originals); assert.equal(f.state().pendingBlockResponse, null)
})

test('repair cannot assign a missing ID to a later valid unit from the same frozen page', async () => {
  const f = store(), last = block('suffix'), malformed = { title: last.title, content: '不同的完整待修正文。', scenes: [] }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async () => {
    if (++calls === 1) return page([malformed, last])
    return repair(patch('block:0', last))
  }, { steps: f.steps() }), { code: 'stage_block_repair_invalid' })
  assert.equal(calls, 2); assert.deepEqual(f.state().blocks, originals)
  assert.deepEqual(f.state().pendingBlockResponse!.value.blocks, [malformed, last])
})

test('metadata repair cannot bypass existing conflict acknowledgements or count the same prose response twice', async () => {
  const f = store(), changed = { ...originals[0]!, content: '冲突改写，南门搬到了北侧。' }, bad = block('pending')
  let calls = 0
  const draft = await generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (calls === 1) return page([changed, { ...bad, scenes: null }])
    if (calls === 2) {
      assert.equal(contract?.name, 'script_stage_block_repair')
      return repair(patch('block:1', bad, { add_empty_scenes: true }))
    }
    assert.equal(calls, 3); assert.equal(f.state().blockConflicts[0]!.occurrences, 1)
    assert.ok(!f.state().blockConflicts[0]!.resolved)
    return page([], true, { resolved_conflicts: f.state().blockConflicts.map(({ id, rejected_hash }) => ({ id, rejected_hash })) })
  }, { steps: f.steps() })
  assert.equal(calls, 3); assert.equal(draft.artifacts[0]!.content, [...originals, bad].map(item => item.content).join('\n\n'))
  assert.ok(!draft.artifacts[0]!.content.includes(changed.content))
})

test('identical malformed pages have only one repair attempt in an invocation', async () => {
  const f = store(), bad = block('pending'), malformed = { ...bad, scenes: null }
  let calls = 0
  await assert.rejects(generateStageDraftWithContinuation(request, prompt, async (_text, contract) => {
    calls++
    if (contract?.name === 'script_stage_block_repair') return repair(patch('block:0', bad, { add_empty_scenes: true }))
    return page([malformed], false)
  }, { steps: f.steps() }), { code: 'stage_continuation_invalid_unit' })
  assert.equal(calls, 3); assert.deepEqual(f.state().blocks, [...originals, bad])
  assert.ok(f.state().pendingBlockResponse)
})
