import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { claimModelAttempt, modelAttemptNumber, runModelStep } from '../src/modules/generation/model-execution.js'
import {
  emptyStageBlockStructure, repairableStageBlock, repairStageBlocks, stageSemanticBlock, type PendingStageBlock,
} from '../src/modules/script/script-stage-block-repair.js'

const body = '  ## 南门与正房\n南门朝南；正房位于北侧，穿过天井可到达西厢。\n'
const block = { id: 'layout:南门', title: '空间与动线', content: body, scenes: [] }
const scene = { heading: '第一场', location: '院子', time_of_day: '日', characters: '林舟', action: '沿天井抵达西厢', dialogue: '从南门进。', narration: '', duration: 10 }
const pending = (value: unknown, index = 0) => {
  const result = repairableStageBlock(value, index, 'locations', 'document')
  assert.ok(result, JSON.stringify(value))
  return result
}
function patch(candidate: PendingStageBlock, overrides: Record<string, unknown> = {}) {
  const raw = candidate.original as Record<string, unknown>
  const id = stageSemanticBlock.shape.id.safeParse(raw.id)
  const title = stageSemanticBlock.shape.title.safeParse(raw.title)
  return { candidate_id: candidate.candidate_id, id: id.success ? id.data : 'layout:补齐标识',
    title: title.success ? title.data : '空间与动线', add_empty_scenes: raw.scenes == null,
    removed_fields: Object.keys(raw).filter(key => ['artifact_type', 'type', 'status', 'episode_number', 'stage', 'complete'].includes(key)), ...overrides }
}
const input = (candidates: PendingStageBlock[]) => ({ stage: 'locations' as const, mode: 'document' as const,
  target: 'location_layouts' as const, retainedTitle: '空间与动线', prompt: '仅修正当前目标的结构字段，不创作正文。', pending: candidates, accepted: [] })
const emptyUnit = (index = 1): PendingStageBlock => ({ candidate_id: `block:${index}`, original: { scenes: [] }, diagnostics: ['缺少正文，不是创作单元。'] })
const discard = (candidate: PendingStageBlock) => ({ candidate_id: candidate.candidate_id, disposition: 'discard_empty_structure' })

test('one-shot metadata repairs claim their actual request before tracing and share a parent step counter', async () => {
  const candidate = pending({ id: block.id, title: block.title, content: body }), attempts: Array<number | undefined> = []
  const generate = async () => {
    attempts.push(modelAttemptNumber())
    return JSON.stringify({ repairs: [patch(candidate)] })
  }
  await repairStageBlocks(input([candidate]), generate)
  await runModelStep('workflow_draft', undefined, async () => {
    claimModelAttempt()
    assert.equal(modelAttemptNumber(), 1)
    await repairStageBlocks(input([candidate]), generate)
    assert.equal(modelAttemptNumber(), 2)
  })
  assert.deepEqual(attempts, [1, 2], 'a repair is an actual request, never an unclaimed zero or a reset nested counter')
})

test('empty structures contain exactly an empty scenes array in project document mode', () => {
  for (const stage of ['outline', 'characters', 'locations', 'props'] as const) {
    assert.equal(emptyStageBlockStructure({ scenes: [] }, stage, 'document'), true)
    assert.equal(emptyStageBlockStructure({ scenes: [] }, stage, 'scenes'), false)
  }
  assert.equal(emptyStageBlockStructure({ scenes: [] }, 'episode', 'document'), false)
  assert.equal(emptyStageBlockStructure({ scenes: [] }, 'episode', 'scenes'), false)
  for (const value of [
    null, [], {}, { scenes: null }, { scenes: {} }, { scenes: [scene] }, { scenes: [null] },
    { scenes: [], id: '' }, { scenes: [], title: '' }, { scenes: [], content: '' },
    { scenes: [], content: ' ' }, { scenes: [], content: '不得丢弃的正文。' },
    { scenes: [], complete: true }, { scenes: [], notes: '额外事实。' }, { scenes: [], id: undefined },
  ]) assert.equal(emptyStageBlockStructure(value, 'locations', 'document'), false)
})

test('one metadata patch explicitly acknowledges empty structures while preserving complete prose byte for byte', async () => {
  const candidate = pending({ id: block.id, title: block.title, content: body }), empty = emptyUnit()
  const before = structuredClone({ candidate, empty }); let calls = 0
  const result = await repairStageBlocks({ ...input([candidate]), empty_units: [empty] }, async (text, contract) => {
    calls++
    assert.equal(contract?.name, 'script_stage_block_repair')
    assert.match(text, /不表示当前目标已经完成/)
    assert.match(text, /不拼接到前一正文/)
    assert.ok(text.includes(JSON.stringify(empty)))
    assert.ok(text.includes(JSON.stringify(candidate)))
    const properties = contract!.schema.properties as any
    assert.ok((contract!.schema.required as string[]).includes('empty_units'))
    assert.equal(properties.empty_units.minItems, 1)
    assert.equal(properties.empty_units.maxItems, 1)
    assert.equal(properties.empty_units.items.properties.content, undefined)
    assert.equal(properties.empty_units.items.properties.scenes, undefined)
    return JSON.stringify({ repairs: [patch(candidate)], empty_units: [discard(empty)] })
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, [block])
  assert.equal(result[0]!.content, body)
  assert.deepEqual({ candidate, empty }, before)
})

test('an empty-only page requires one explicit acknowledgement and a mandatory empty repairs array', async () => {
  const empty = emptyUnit(0), before = structuredClone(empty); let calls = 0
  const result = await repairStageBlocks({ ...input([]), empty_units: [empty] }, async (_text, contract) => {
    calls++
    const properties = contract!.schema.properties as any
    assert.equal(properties.repairs.maxItems, 0)
    assert.ok((contract!.schema.required as string[]).includes('repairs'))
    return JSON.stringify({ repairs: [], empty_units: [discard(empty)] })
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, [], 'acknowledging an empty structure never invents a prose block')
  assert.deepEqual(empty, before)
  await assert.rejects(repairStageBlocks({ ...input([]), empty_units: [empty] }, async () => JSON.stringify({ empty_units: [discard(empty)] })),
    (error: any) => error.code === 'stage_block_repair_invalid')
})

test('empty acknowledgements require exact original indices, order, count and disposition', async t => {
  const first = emptyUnit(1), last = emptyUnit(3), candidate = pending({ ...block, status: 'draft' })
  const variations = [
    { repairs: [patch(candidate)] },
    { repairs: [patch(candidate)], empty_units: [] },
    { repairs: [patch(candidate)], empty_units: [discard(first)] },
    { repairs: [patch(candidate)], empty_units: [discard(first), discard(first)] },
    { repairs: [patch(candidate)], empty_units: [discard(last), discard(first)] },
    { repairs: [patch(candidate)], empty_units: [discard(first), { ...discard(last), candidate_id: 'block:2' }] },
    { repairs: [patch(candidate)], empty_units: [discard(first), { ...discard(last), disposition: 'merge_into_previous' }] },
    { repairs: [patch(candidate)], empty_units: [discard(first), { ...discard(last), content: '伪造正文。' }] },
    { repairs: [patch(candidate)], empty_units: [discard(first), discard(last)], complete: true },
  ]
  for (const [index, response] of variations.entries()) await t.test(`invalid acknowledgement ${index}`, async () => {
    let calls = 0
    await assert.rejects(repairStageBlocks({ ...input([candidate]), empty_units: [first, last] }, async () => { calls++; return JSON.stringify(response) }),
      (error: any) => {
        assert.equal(error.code, 'stage_block_repair_invalid')
        assert.ok(error.diagnostic.fields.includes('empty_units'))
        assert.equal(error.raw_output, undefined, 'diagnostics never preserve model-returned creative text')
        return true
      })
    assert.equal(calls, 1)
  })
})

test('forged empty inputs cannot discard scene data, unknown fields or duplicate candidate identities', async t => {
  const candidate = pending({ ...block, status: 'draft' })
  const variants = [
    { ...input([]), empty_units: [{ ...emptyUnit(), original: { scenes: [scene] } }] },
    { ...input([]), empty_units: [{ ...emptyUnit(), original: { scenes: [], notes: '不可删除的创作信息。' } }] },
    { ...input([]), empty_units: [{ ...emptyUnit(), original: { scenes: [], content: '' } }] },
    { ...input([]), empty_units: [{ ...emptyUnit(), original: { scenes: [] }, extra: '未知候选字段' }] },
    { ...input([]), empty_units: [emptyUnit(), emptyUnit()] },
    { ...input([candidate]), empty_units: [{ ...emptyUnit(), candidate_id: candidate.candidate_id }] },
    { ...input([]), stage: 'episode' as const, target: 'episode_script' as const, empty_units: [emptyUnit()] },
    { ...input([]), mode: 'scenes' as const, empty_units: [emptyUnit()] },
  ]
  for (const [index, options] of variants.entries()) await t.test(`unsafe empty input ${index}`, async () => {
    let calls = 0
    await assert.rejects(repairStageBlocks(options, async () => { calls++; return '{}' }),
      (error: any) => error.code === 'stage_block_repair_invalid' && error.diagnostic.fields.includes('empty_units'))
    assert.equal(calls, 0)
  })
})

test('empty-only cancellation and transport failures keep originals unchanged and do not replay the patch', async () => {
  const empty = emptyUnit(), before = structuredClone(empty), controller = new AbortController(); let calls = 0
  await assert.rejects(repairStageBlocks({ ...input([]), empty_units: [empty] }, async () => {
    calls++; controller.abort(); return JSON.stringify({ repairs: [], empty_units: [discard(empty)] })
  }, { signal: controller.signal }), (error: any) => error.name === 'AbortError')
  assert.equal(calls, 1)
  assert.deepEqual(empty, before)
  const failure = new TextProviderError('connection failed', true, 'bad_response_body'); calls = 0
  await assert.rejects(repairStageBlocks({ ...input([]), empty_units: [empty] }, async () => { calls++; throw failure }), error => error === failure)
  assert.equal(calls, 1)
  assert.deepEqual(empty, before)
})

test('missing or null project scenes require an explicit patch and preserve every body byte', async t => {
  for (const original of [{ id: block.id, title: block.title, content: body }, { ...block, scenes: null }]) await t.test(JSON.stringify(original), async () => {
    const candidate = pending(original), before = structuredClone(candidate)
    let calls = 0
    const result = await repairStageBlocks(input([candidate]), async (text, contract) => {
      calls++
      assert.equal(contract?.name, 'script_stage_block_repair')
      assert.ok(text.includes(JSON.stringify(original)), 'the whole quarantined unit remains available as data')
      const properties = ((contract!.schema.properties as any).repairs.items.properties)
      assert.equal(properties.content, undefined)
      assert.equal(properties.scenes, undefined)
      return JSON.stringify({ repairs: [patch(candidate)] })
    })
    assert.deepEqual(result, [block])
    assert.equal(result[0]!.content, body)
    assert.deepEqual(candidate, before)
    assert.equal(calls, 1)
  })
})

test('known save metadata is removed only with exact per-field acknowledgement', async () => {
  const original = { ...block, artifact_type: 'location_layouts', type: 'location_layouts', status: 'draft', stage: 'locations', episode_number: 0, complete: true }
  const candidate = pending(original)
  const result = await repairStageBlocks(input([candidate]), async () => JSON.stringify({ repairs: [patch(candidate)] }))
  assert.deepEqual(result, [block])
  assert.deepEqual(candidate.original, original)
})

test('missing and overlong metadata can be repaired without returning or rewriting prose', async t => {
  for (const original of [
    { content: body, scenes: [] },
    { ...block, id: 'x'.repeat(161), title: 'y'.repeat(161) },
    { ...block, id: '', title: null },
  ]) await t.test(JSON.stringify(original), async () => {
    const candidate = pending(original)
    const result = await repairStageBlocks(input([candidate]), async () => JSON.stringify({ repairs: [patch(candidate)] }))
    assert.equal(result[0]!.id, 'layout:补齐标识')
    assert.equal(result[0]!.title, '空间与动线')
    assert.equal(result[0]!.content, body)
    assert.deepEqual(result[0]!.scenes, [])
  })
})

test('valid IDs and titles cannot be replaced by a metadata repair', async t => {
  const candidate = pending({ ...block, status: 'draft' })
  for (const overrides of [{ id: 'layout:改写标识' }, { title: '改写标题' }]) await t.test(JSON.stringify(overrides), async () => {
    let calls = 0
    await assert.rejects(repairStageBlocks(input([candidate]), async () => {
      calls++; return JSON.stringify({ repairs: [patch(candidate, overrides)] })
    }), (error: any) => error.code === 'stage_block_repair_invalid')
    assert.equal(calls, 1)
    assert.equal((candidate.original as any).content, body)
  })
})

test('content, scenes or unknown creative fields in a patch are rejected rather than stripped', async t => {
  const candidate = pending({ ...block, status: 'draft' })
  for (const overrides of [{ content: '改写空间事实。' }, { scenes: [] }, { notes: '新增创作信息。' }]) await t.test(JSON.stringify(overrides), async () => {
    let calls = 0
    await assert.rejects(repairStageBlocks(input([candidate]), async () => {
      calls++; return JSON.stringify({ repairs: [patch(candidate, overrides)] })
    }), (error: any) => error.code === 'stage_block_repair_invalid')
    assert.equal(calls, 1, 'a failed field patch does not cause a second generation request')
  })
})

test('scene-array changes and incomplete or duplicate deletion acknowledgements cannot pass', async t => {
  const candidate = pending({ ...block, status: 'draft' })
  for (const overrides of [
    { add_empty_scenes: true }, { removed_fields: [] }, { removed_fields: ['status', 'status'] }, { removed_fields: ['status', 'complete'] },
  ]) await t.test(JSON.stringify(overrides), async () => {
    await assert.rejects(repairStageBlocks(input([candidate]), async () => JSON.stringify({ repairs: [patch(candidate, overrides)] })),
      (error: any) => error.code === 'stage_block_repair_invalid')
  })
  const absentScenes = pending({ id: block.id, title: block.title, content: body })
  await assert.rejects(repairStageBlocks(input([absentScenes]), async () => JSON.stringify({ repairs: [patch(absentScenes, { add_empty_scenes: false })] })),
    (error: any) => error.code === 'stage_block_repair_invalid')
})

test('candidate mapping is complete, unique and in original order; repaired IDs cannot collide', async t => {
  const first = pending({ ...block, status: 'draft' }), second = pending({ ...block, id: 'layout:西厢', content: '西厢位于正房西侧。', status: 'draft' }, 1)
  const candidates = [first, second]
  for (const repairs of [
    [patch(second), patch(first)], [patch(first), patch(first)], [patch(first)],
    [patch(first), patch(second, { id: block.id })],
  ]) await t.test(JSON.stringify(repairs), async () => {
    await assert.rejects(repairStageBlocks(input(candidates), async () => JSON.stringify({ repairs })), (error: any) => error.code === 'stage_block_repair_invalid')
  })
})

test('idempotent accepted units tolerate only metadata correction while changed prose or invented accepted IDs fail', async () => {
  const accepted = stageSemanticBlock.parse(block)
  const original = { ...block, title: '本页展示标题', status: 'draft' }, candidate = pending(original)
  const result = await repairStageBlocks({ ...input([candidate]), accepted: [accepted] }, async () => JSON.stringify({ repairs: [patch(candidate)] }))
  assert.equal(result[0]!.id, accepted.id)
  assert.equal(result[0]!.title, original.title, 'root retains the current target title after field repair')
  assert.equal(result[0]!.content, accepted.content)
  for (const [candidate, overrides] of [
    [pending({ ...block, content: '改写已收空间布局。', status: 'draft' }), {}],
    [pending({ title: block.title, content: block.content, scenes: [] }), { id: accepted.id }],
  ] as const) await assert.rejects(repairStageBlocks({ ...input([candidate]), accepted: [accepted] },
    async () => JSON.stringify({ repairs: [patch(candidate, overrides)] })), (error: any) => error.code === 'stage_block_repair_invalid')
})

test('eligibility never accepts missing prose, semantic scene errors or unknown creative data', () => {
  for (const original of [
    { ...block, content: null }, { ...block, content: '' }, { ...block, content: ' '.repeat(3) },
    { ...block, content: 'x'.repeat(100001) }, { ...block, scenes: [scene] },
    { ...block, notes: '应保留的额外正文' }, { ...block, status: { explanation: '有创作内容' } },
    { ...block, stage: 'characters' }, { ...block, type: 'characters' }, { ...block, complete: 'true' },
    { ...block, id: { arbitrary: 'data' } },
  ]) assert.equal(repairableStageBlock(original, 0, 'locations', 'document'), null)
  assert.equal(repairableStageBlock(block, 0, 'locations', 'document'), null, 'a valid block requires no repair')
  assert.equal(repairableStageBlock({ ...block, scenes: null }, 0, 'episode', 'document'), null)
  assert.equal(repairableStageBlock({ ...block, content: '', scenes: [] }, 0, 'episode', 'scenes'), null)
})

test('wrong-target metadata or a tampered pending candidate fails before any model request', async () => {
  const candidates = [pending({ ...block, artifact_type: 'location_atmosphere' }), { ...pending({ ...block, status: 'draft' }), original: { ...block, notes: '不得丢弃' } }]
  for (const candidate of candidates) {
    let calls = 0
    await assert.rejects(repairStageBlocks(input([candidate]), async () => { calls++; return '{}' }),
      (error: any) => error.code === 'stage_block_repair_invalid')
    assert.equal(calls, 0)
  }
})

test('episode scene bodies are immutable during an eligible metadata repair', async () => {
  // Deliberately use a different key insertion order: scene identity is its
  // actual field values, never JSON object member ordering.
  const original = { id: 'scene:1', title: '第1集', content: '', scenes: [{ duration: 10, ...scene }], status: 'draft' }
  const candidate = repairableStageBlock(original, 0, 'episode', 'scenes')
  assert.ok(candidate)
  const result = await repairStageBlocks({ stage: 'episode', mode: 'scenes', target: 'episode_script', prompt: '仅修正单元字段。', pending: [candidate], accepted: [] },
    async () => JSON.stringify({ repairs: [patch(candidate)] }))
  assert.deepEqual(result[0]!.scenes, original.scenes)
  assert.equal(result[0]!.content, '')
  assert.equal(repairableStageBlock({ ...original, scenes: [{ ...scene, duration: null }] }, 0, 'episode', 'scenes'), null)
  assert.equal(repairableStageBlock({ ...original, scenes: [{ ...scene, extra_prose: '未知正文' }] }, 0, 'episode', 'scenes'), null)
})

test('a malformed patch stops after one call and retryable transport errors are not replayed', async () => {
  const candidate = pending({ ...block, status: 'draft' })
  let calls = 0
  await assert.rejects(repairStageBlocks(input([candidate]), async () => { calls++; return '{"repairs":[' }),
    (error: any) => error.code === 'stage_block_repair_invalid')
  assert.equal(calls, 1)
  const transport = new TextProviderError('network disconnected', true, 'bad_response_body')
  calls = 0
  await assert.rejects(repairStageBlocks(input([candidate]), async () => { calls++; throw transport }), error => error === transport)
  assert.equal(calls, 1)
})

test('cancellation rejects the patch without mutating the frozen candidate', async () => {
  const candidate = pending({ ...block, status: 'draft' }), before = structuredClone(candidate), controller = new AbortController()
  let calls = 0
  await assert.rejects(repairStageBlocks(input([candidate]), async () => {
    calls++; controller.abort(); return JSON.stringify({ repairs: [patch(candidate)] })
  }, { signal: controller.signal }), (error: any) => error.name === 'AbortError')
  assert.equal(calls, 1)
  assert.deepEqual(candidate, before)
})
