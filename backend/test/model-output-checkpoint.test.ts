import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredGenerator, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { fixedLocalRepair } from '../src/modules/generation/model-output-local-repair.js'
import { currentModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'

const schema = z.object({
  source_id: z.string().min(1),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), start: z.number().int(), end: z.number().int() }).strict()),
  locked: z.object({ dialogue: z.string(), sound: z.string() }).strict(),
}).strict()
const candidate = () => ({ source_id: 'source-unchanged', chapters: [
  { id: 'chapter-a', title: '第一章', start: 1, end: 5 },
  { id: 'chapter-b', title: '第二章完整正文', start: 6, end: 10 },
], locked: { dialogue: '原对白必须逐字保留。', sound: '延续原环境底噪' } })
const invalidCandidate = () => {
  const value = candidate()
  value.chapters[0]!.title = ''
  return value
}
const patch = () => ({ repairs: { repair_0: '第一章' } })
const prompt = '只依据这份原稿分析目录，保留原人物、对白与声音。'
const contractName = 'checkpoint_fixture'
function storage() {
  let durable: StructuredOutputCheckpoint = {}
  let saves = 0
  const checkpoint: StructuredOutputCheckpoint = {}
  return { checkpoint, persist: () => { saves++; durable = structuredClone(checkpoint) }, saved: () => structuredClone(durable), saves: () => saves }
}
const noRequest: StructuredGenerator = async () => { assert.fail('saved complete output must never dispatch another model request') }
function checkpointFailure(error: unknown, cause: Error) {
  assert.ok(error instanceof Error)
  const failure = error as Error & { statusCode?: number; structuredOutputContract?: string }
  assert.equal(failure.statusCode, 500)
  assert.equal(failure.cause, cause)
  assert.equal(failure.structuredOutputContract, undefined, 'persistence faults cannot become a model validation failure')
  return true
}

// A restart receives a deserialized durable checkpoint, not the original object.
test('a valid complete candidate survives restart and is replayed with zero model requests', async () => {
  const store = storage()
  let calls = 0
  const result = await generateStructuredOutput(contractName, schema, async () => { calls++; return JSON.stringify(candidate()) }, prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true })
  assert.equal(calls, 1)
  assert.deepEqual(result, candidate())
  const restored = store.saved()
  assert.deepEqual(JSON.parse(restored.raw!), candidate())
  assert.equal(restored.correction, undefined)
  assert.deepEqual(await generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored, structuralRepair: true }), candidate())
})

test('an interrupted correction retains the original proposal and cannot silently consume a second correction', async () => {
  const store = storage(), initial = invalidCandidate(), before = structuredClone(initial)
  const interruption = new Error('repair interrupted before a complete response')
  const dispatched: string[] = []
  await assert.rejects(generateStructuredOutput(contractName, schema, async (_text, contract) => {
    dispatched.push(contract!.name)
    if (contract!.name.endsWith('_structure_repair')) throw interruption
    return JSON.stringify(initial)
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true }), error => error === interruption)
  assert.deepEqual(dispatched, [contractName, contractName + '_structure_repair'])
  const restored = store.saved()
  assert.deepEqual(JSON.parse(restored.raw!), before)
  assert.equal(restored.correction, undefined)
  await assert.rejects(generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored, structuralRepair: true }), error => (error as any).code === 'structured_correction_exhausted')
  // Only an explicit caller-owned reset grants another correction.
  delete restored.correction_started
  let repairCalls = 0
  const result = await generateStructuredOutput(contractName, schema, async (_text, contract, context) => {
    repairCalls++
    assert.equal(contract!.name, contractName + '_structure_repair')
    assert.equal(context?.operationStage, 'format_correction', 'a cached first response cannot relabel a resumed repair as initial generation')
    assert.equal(currentModelRequestContext()?.operationStage, 'format_correction')
    assert.equal(currentModelRequestContext(), context)
    return JSON.stringify(patch())
  }, prompt, { checkpoint: restored, structuralRepair: true })
  assert.equal(repairCalls, 1)
  assert.deepEqual(result, candidate())
  assert.deepEqual(initial, before)
  assert.deepEqual(result.chapters[1], before.chapters[1])
  assert.deepEqual(result.locked, before.locked)
  assert.equal(result.source_id, before.source_id)
  assert.deepEqual(JSON.parse(restored.raw!), candidate())
  assert.deepEqual(JSON.parse(restored.correction!.raw), patch())
  assert.ok(restored.correction_started, 'a successful correction still retains its consumed allowance')
  assert.deepEqual(await generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored, structuralRepair: true }), candidate())
})

test('an invalid fixed-field patch replays locally until explicit repair reset, then stores the merged complete candidate', async () => {
  const store = storage(), initial = invalidCandidate(), invalidPatch = { repairs: { repair_0: 42, free_path: ['locked', 'dialogue'] } }
  let calls = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => JSON.stringify(++calls === 1 ? initial : invalidPatch), prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true }), /已修正一次/)
  assert.equal(calls, 2)
  const restored = store.saved()
  assert.deepEqual(JSON.parse(restored.raw!), initial)
  assert.deepEqual(JSON.parse(restored.correction!.raw), invalidPatch)
  await assert.rejects(generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored, structuralRepair: true }), /已修正一次/)
  assert.deepEqual(JSON.parse(restored.raw!), initial)
  delete restored.correction
  delete restored.correction_started
  let explicitRepairCalls = 0
  const result = await generateStructuredOutput(contractName, schema, async (_text, contract, context) => {
    explicitRepairCalls++
    assert.equal(contract!.name, contractName + '_structure_repair')
    assert.equal(context?.operationStage, 'format_correction')
    assert.equal(currentModelRequestContext()?.operationStage, 'format_correction')
    assert.equal(currentModelRequestContext(), context)
    return JSON.stringify(patch())
  }, prompt, { checkpoint: restored, structuralRepair: true })
  assert.equal(explicitRepairCalls, 1)
  assert.deepEqual(result, candidate())
  assert.deepEqual(result.locked, initial.locked)
  assert.deepEqual(result.chapters[1], initial.chapters[1])
  assert.deepEqual(JSON.parse(restored.raw!), candidate())
  assert.deepEqual(JSON.parse(restored.correction!.raw), patch())
  assert.ok(restored.correction_started, 'a successful correction still retains its consumed allowance')
})

test('a full-object format correction is also cached when its response is invalid', async () => {
  const store = storage()
  let calls = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async (_text, contract) => {
    calls++
    assert.equal(contract!.name, contractName)
    return calls === 1 ? 'not a JSON result' : JSON.stringify({ source_id: 'incomplete' })
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist }), /已修正一次/)
  assert.equal(calls, 2)
  const restored = store.saved()
  assert.equal(restored.raw, 'not a JSON result')
  assert.deepEqual(JSON.parse(restored.correction!.raw), { source_id: 'incomplete' })
  await assert.rejects(generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored }), /已修正一次/)
})

test('changing the task prompt invalidates old raw output and its correction before dispatch', async () => {
  const store = storage()
  let calls = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => JSON.stringify(++calls === 1 ? invalidCandidate() : { repairs: {} }), prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true }), /已修正一次/)
  const restored = store.saved(), oldHash = restored.input_hash
  const newValue = { ...candidate(), source_id: 'replacement-source' }
  let changedCalls = 0
  const result = await generateStructuredOutput(contractName, schema, async (_text, contract) => {
    changedCalls++
    assert.equal(contract!.name, contractName)
    assert.equal(restored.raw, undefined)
    assert.equal(restored.original_raw, undefined, 'changed input clears old original-response identity before dispatch')
    assert.equal(restored.correction, undefined)
    return JSON.stringify(newValue)
  }, prompt + '\n使用更新后的原稿。', { checkpoint: restored, structuralRepair: true })
  assert.equal(changedCalls, 1)
  assert.notEqual(restored.input_hash, oldHash)
  assert.deepEqual(result, newValue)
})

test('changing the output schema invalidates a previous complete candidate', async () => {
  const store = storage()
  await generateStructuredOutput(contractName, schema, async () => JSON.stringify(candidate()), prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist })
  const restored = store.saved(), oldHash = restored.input_hash
  const changedSchema = schema.extend({ revision: z.number().int() }), expected = { ...candidate(), revision: 2 }
  let calls = 0
  const result = await generateStructuredOutput(contractName, changedSchema, async () => {
    calls++
    assert.equal(restored.raw, undefined)
    assert.equal(restored.original_raw, undefined, 'changed input clears old original-response identity before dispatch')
    return JSON.stringify(expected)
  }, prompt, { checkpoint: restored })
  assert.equal(calls, 1)
  assert.notEqual(restored.input_hash, oldHash)
  assert.deepEqual(result, expected)
})

test('checkpoint write failure before dispatch or after initial output never causes a model correction', async () => {
  for (const afterResponse of [false, true]) {
    const checkpoint: StructuredOutputCheckpoint = {}, failure = new Error('checkpoint persistence failed')
    let calls = 0
    await assert.rejects(generateStructuredOutput(contractName, schema, async () => { calls++; return JSON.stringify(invalidCandidate()) }, prompt, {
      checkpoint, structuralRepair: true, persistCheckpoint: () => { if (!afterResponse || checkpoint.raw !== undefined) throw failure },
    }), error => checkpointFailure(error, failure))
    assert.equal(calls, afterResponse ? 1 : 0)
    assert.equal(checkpoint.correction, undefined)
  }
})

test('checkpoint write failure after successful validation does not create a paid format correction', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, failure = new Error('complete checkpoint persistence failed')
  let calls = 0, saves = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => { calls++; return JSON.stringify(candidate()) }, prompt, {
    checkpoint, structuralRepair: true, persistCheckpoint: () => { if (++saves >= 3) throw failure },
  }), error => checkpointFailure(error, failure))
  assert.equal(calls, 1)
  assert.equal(checkpoint.correction, undefined)
})

test('checkpoint write failure for a correction preserves the original complete candidate and does not dispatch again', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, failure = new Error('correction checkpoint persistence failed'), initial = invalidCandidate()
  let calls = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => JSON.stringify(++calls === 1 ? initial : patch()), prompt, {
    checkpoint, structuralRepair: true, persistCheckpoint: () => { if (checkpoint.correction !== undefined) throw failure },
  }), error => checkpointFailure(error, failure))
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(checkpoint.raw!), initial)
})

test('checkpoint write failure after merging a fixed-field patch remains an execution failure', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, failure = new Error('merged checkpoint persistence failed')
  let calls = 0, saves = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => JSON.stringify(++calls === 1 ? invalidCandidate() : patch()), prompt, {
    checkpoint, structuralRepair: true, persistCheckpoint: () => { if (++saves >= 4) throw failure },
  }), error => checkpointFailure(error, failure))
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(checkpoint.raw!).locked, candidate().locked)
  assert.deepEqual(JSON.parse(checkpoint.raw!).chapters[1], candidate().chapters[1])
})

test('a cancelled invocation never replays a cached candidate or correction', async () => {
  const store = storage()
  await generateStructuredOutput(contractName, schema, async () => JSON.stringify(candidate()), prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist })
  const controller = new AbortController(), cancelled = new DOMException('creator cancelled', 'AbortError')
  controller.abort(cancelled)
  const restored = store.saved(), before = structuredClone(restored)
  await assert.rejects(generateStructuredOutput(contractName, schema, noRequest, prompt, { checkpoint: restored, signal: controller.signal }), error => error === cancelled)
  assert.deepEqual(restored, before)
})

test('cancellation retains a complete late repair privately but an aborted resume cannot dispatch', async () => {
  const store = storage(), controller = new AbortController(), cancelled = new DOMException('creator cancelled repair', 'AbortError')
  let calls = 0
  await assert.rejects(generateStructuredOutput(contractName, schema, async (_text, contract) => {
    calls++
    if (contract!.name.endsWith('_structure_repair')) { controller.abort(cancelled); return JSON.stringify(patch()) }
    return JSON.stringify(invalidCandidate())
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true, signal: controller.signal }), error => error === cancelled)
  assert.equal(calls, 2)
  const restored = store.saved()
  assert.deepEqual(JSON.parse(restored.raw!), invalidCandidate())
  assert.deepEqual(JSON.parse(restored.correction!.raw), patch())
  await assert.rejects(generateStructuredOutput(contractName, schema, noRequest, prompt, {
    checkpoint: restored, structuralRepair: true, signal: controller.signal,
  }), error => error === cancelled)
})


test('wrapped primitive results retain their wire envelope and replay without another request', async () => {
  const store = storage()
  let calls = 0
  const result = await generateStructuredOutput('checkpoint_wrapped_primitive', z.string().min(1), async () => {
    calls++
    return JSON.stringify({ result: '保留的完整分析结论' })
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist })
  assert.equal(result, '保留的完整分析结论')
  assert.equal(calls, 1)
  const restored = store.saved()
  assert.deepEqual(await generateStructuredOutput('checkpoint_wrapped_primitive', z.string().min(1), noRequest, prompt, { checkpoint: restored }), result)
  assert.deepEqual(JSON.parse(restored.raw!), { result })
})

test('wrapped unions keep a business result field distinct from the wire result envelope on replay', async () => {
  const wrappedUnion = z.union([
    z.object({ kind: z.literal('finding'), result: z.string().min(1), source_id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('empty'), reason: z.string().min(1) }).strict(),
  ])
  const expected = { kind: 'finding' as const, result: '业务字段不能当成外层封套', source_id: 'source-kept' }
  const store = storage()
  let calls = 0
  assert.deepEqual(await generateStructuredOutput('checkpoint_wrapped_union', wrappedUnion, async () => {
    calls++
    return JSON.stringify({ result: expected })
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist }), expected)
  assert.equal(calls, 1)
  const restored = store.saved()
  assert.deepEqual(await generateStructuredOutput('checkpoint_wrapped_union', wrappedUnion, noRequest, prompt, { checkpoint: restored }), expected)
  assert.deepEqual(JSON.parse(restored.raw!), { result: expected })
})


test('checkpoint fallback format correction receives the complete long candidate including its opening and ending', async () => {
  const broadSchema = schema.extend({ chapters: schema.shape.chapters.min(3) })
  const initial = candidate()
  initial.locked.dialogue = 'OPENING_CANDIDATE_SENTINEL\n' + '完整正文不可丢失。'.repeat(2500) + '\nENDING_CANDIDATE_SENTINEL'
  const raw = JSON.stringify(initial)
  assert.ok(raw.length > 12000)
  assert.ok(!raw.slice(-12000).includes('OPENING_CANDIDATE_SENTINEL'))
  const expected = { ...initial, chapters: [...initial.chapters, { id: 'chapter-c', title: '第三章', start: 11, end: 15 }] }
  const store = storage()
  let calls = 0
  const result = await generateStructuredOutput('checkpoint_long_fallback', broadSchema, async (text, contract) => {
    calls++
    assert.equal(contract!.name, 'checkpoint_long_fallback', 'a container count error cannot authorize a fixed-field structure patch')
    if (calls === 1) return raw
    assert.match(text, /一次格式修正/)
    assert.doesNotMatch(text, /一次结构定向修复/)
    assert.ok(text.includes('OPENING_CANDIDATE_SENTINEL'))
    assert.ok(text.includes('ENDING_CANDIDATE_SENTINEL'))
    assert.ok(text.includes(JSON.stringify(raw)), 'the complete retained candidate must be provided, not only its suffix')
    return JSON.stringify(expected)
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist, structuralRepair: true })
  assert.equal(calls, 2)
  assert.deepEqual(result, expected)
  assert.deepEqual(result.locked, initial.locked)
  assert.deepEqual(result.chapters.slice(0, 2), initial.chapters)
  assert.deepEqual(await generateStructuredOutput('checkpoint_long_fallback', broadSchema, noRequest, prompt, { checkpoint: store.saved(), structuralRepair: true }), expected)
})


const privateTitlePlan = (value: unknown) => fixedLocalRepair({ candidate: value, targets: [
  { key: 'chapter_title', path: ['chapters', 0, 'title'], schema: z.string().min(1) },
], prompt: 'Only correct the fixed first chapter title; retain every sibling verbatim.' })

test('a successful local correction retains the exact initial whitespace and correction response as well as canonical replay and consumed allowance', async () => {
  const store = storage(), initialRaw = ' \r\n' + JSON.stringify(invalidCandidate(), null, 2) + '\n  '
  const correctionRaw = '\n ' + JSON.stringify({ repairs: { chapter_title: '第一章' } }, null, 2) + '\r\n'
  let calls = 0
  const result = await generateStructuredOutput(contractName, schema, async (_text, contract) => {
    calls++
    return contract!.name.endsWith('_local_repair') ? correctionRaw : initialRaw
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist, planLocalRepair: privateTitlePlan })
  assert.equal(calls, 2); assert.deepEqual(result, candidate())
  const restored = JSON.parse(JSON.stringify(store.saved())) as StructuredOutputCheckpoint
  assert.equal(restored.original_raw, initialRaw, 'first provider response stays byte-for-byte complete, including surrounding whitespace')
  assert.equal(restored.correction!.raw, correctionRaw, 'the actual correction response is retained independently of canonical output')
  assert.equal(restored.correction_started!.input_hash, restored.correction!.input_hash)
  assert.equal(restored.raw, JSON.stringify(candidate()), 'the existing canonical replay field remains compatible')
  assert.deepEqual(await generateStructuredOutput(contractName, schema, noRequest, prompt,
    { checkpoint: restored, planLocalRepair: privateTitlePlan }), candidate())
  assert.equal(calls, 2); assert.equal(restored.original_raw, initialRaw); assert.equal(restored.correction!.raw, correctionRaw)
  assert.ok(restored.correction_started)
})

test('an old canonical checkpoint replays without fabricating an original provider response', async () => {
  const store = storage()
  await generateStructuredOutput(contractName, schema, async () => JSON.stringify(candidate()), prompt,
    { checkpoint: store.checkpoint, persistCheckpoint: store.persist })
  const legacy: StructuredOutputCheckpoint = { input_hash: store.saved().input_hash, raw: JSON.stringify(candidate()) }
  let saves = 0
  assert.deepEqual(await generateStructuredOutput(contractName, schema, noRequest, prompt,
    { checkpoint: legacy, persistCheckpoint: () => { saves++ } }), candidate())
  assert.ok(saves > 0, 'revalidation may persist canonical output without inventing historical raw provenance')
  assert.equal(legacy.original_raw, undefined); assert.equal(legacy.correction, undefined); assert.equal(legacy.correction_started, undefined)
})

test('a changed same-hash business validator cannot buy another correction after a successful correction already consumed it', async () => {
  const store = storage(), initialRaw = JSON.stringify(invalidCandidate()), correctionRaw = JSON.stringify({ repairs: { chapter_title: '第一章' } })
  let calls = 0
  await generateStructuredOutput(contractName, schema, async (_text, contract) => {
    calls++; return contract!.name.endsWith('_local_repair') ? correctionRaw : initialRaw
  }, prompt, { checkpoint: store.checkpoint, persistCheckpoint: store.persist, planLocalRepair: privateTitlePlan })
  const restored = JSON.parse(JSON.stringify(store.saved())) as StructuredOutputCheckpoint, hash = restored.input_hash
  await assert.rejects(generateStructuredOutput(contractName, schema, async () => { calls++; assert.fail('consumed same-input correction cannot dispatch again') }, prompt,
    { checkpoint: restored, planLocalRepair: privateTitlePlan, validate: () => { throw Object.assign(new Error('first chapter now fails a current domain check'), { statusCode: 422 }) } }),
    error => {
      assert.equal((error as { structuredOutputContract?: string }).structuredOutputContract, contractName)
      assert.match((error as Error).message, /已修正一次/); assert.match((error as Error).message, /first chapter now fails/); return true
    })
  assert.equal(calls, 2); assert.equal(restored.input_hash, hash)
  assert.equal(restored.original_raw, initialRaw); assert.equal(restored.correction!.raw, correctionRaw); assert.ok(restored.correction_started)
  assert.equal(restored.raw, JSON.stringify(candidate()), 'private canonical replay does not imply adoption under a failing current domain validator')
})

test('frozen full correction replays its exact completed request when business diagnostics change', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, schema = z.object({ answer: z.string() }).strict()
  let calls = 0, diagnostic = '第一个业务诊断'
  const generate: StructuredGenerator = async () => { calls++; return calls === 1 ? '{"answer":"原提案"}' : '{"answer":"完整保留"}' }
  const options = { checkpoint, freezeCorrection: true, preserveInputIdentity: true, validate: () => { throw new Error(diagnostic) } }
  await assert.rejects(generateStructuredOutput('script_source_story_uncertainties', schema, generate, '同一逻辑任务', options), /第一个业务诊断/)
  assert.equal(calls, 2); const frozen = structuredClone(checkpoint.correction_request)
  diagnostic = '新的诊断只说明当前问题'
  await assert.rejects(generateStructuredOutput('script_source_story_uncertainties', schema, noRequest, '同一逻辑任务', options), /新的诊断/)
  assert.equal(calls, 2); assert.deepEqual(checkpoint.correction_request, frozen)
  assert.equal(checkpoint.correction!.input_hash, frozen!.input_hash)
})
test('syntax failure retains complete correction bytes, precise location and used allowance', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}, schema = z.object({ description: z.string() }).strict()
  const invalid = '{"description":"他自称"巡夜司"，是否有人继承未知"}'
  let calls = 0
  const options = { checkpoint, freezeCorrection: true, preserveInputIdentity: true }
  await assert.rejects(generateStructuredOutput('script_source_story_uncertainties', schema, async () => { calls++; return invalid }, '保留引号', options), error => {
    assert.equal((error as any).code, 'model_json_syntax'); assert.match((error as Error).message, /JSON 语法错误：位置/); return true
  })
  assert.equal(calls, 2); assert.equal(checkpoint.original_raw, invalid); assert.equal(checkpoint.correction!.raw, invalid)
  await assert.rejects(generateStructuredOutput('script_source_story_uncertainties', schema, noRequest, '保留引号', options), /JSON 语法错误：位置/)
})
test('source native schema keeps explicit textual field requirements even when the gateway accepts parameters', async () => {
  const { nativeOutputContractPrompt } = await import('../src/modules/generation/model-output.js')
  await generateStructuredOutput('script_source_story_uncertainties', z.object({ description: z.string().describe('FIELD_REQUIREMENT') }).strict(), async (prompt, contract) => {
    assert.equal(nativeOutputContractPrompt(prompt, contract), prompt); assert.match(prompt, /FIELD_REQUIREMENT/)
    return '{"description":"完整"}'
  }, '正文不省略')
})

test('initial dispatch guards survive restart for unknown outcomes and release only on explicit provider facts', async t => {
  for (const outcome of ['ordinary_error', 'accepted', 'output_started', 'cancelled', 'not_sent', 'rejected', 'terminal_error', 'completed'] as const) {
    await t.test(outcome, async () => {
      const checkpoint: StructuredOutputCheckpoint = {}, schema = z.object({ answer: z.string() }).strict()
      const controller = new AbortController()
      const unknown = ['ordinary_error', 'accepted', 'output_started', 'cancelled'].includes(outcome)
      const error = outcome === 'ordinary_error' || outcome === 'cancelled' ? new Error('unknown fixture outcome')
        : Object.assign(new TextProviderError('explicit fixture provider outcome', false), {
          delivery: outcome === 'terminal_error' ? 'accepted' : outcome,
          responseTerminated: outcome === 'terminal_error',
        })
      let calls = 0
      await assert.rejects(generateStructuredOutput('script_source_story_uncertainties', schema, async () => {
        calls++
        if (outcome === 'cancelled') controller.abort(error)
        throw error
      }, 'same logical request', { checkpoint, guardInitialDispatch: true, preserveInputIdentity: true, signal: controller.signal }), issue => issue === error)
      const restored = JSON.parse(JSON.stringify(checkpoint)) as StructuredOutputCheckpoint
      assert.equal(!!restored.initial_started, unknown)
      const before = structuredClone(restored)
      const resume = () => generateStructuredOutput('script_source_story_uncertainties', schema, async () => {
        calls++; return '{"answer":"complete"}'
      }, 'same logical request', { checkpoint: restored, guardInitialDispatch: true, preserveInputIdentity: true })
      if (unknown) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(resume(), issue => (issue as { code?: string }).code === 'structured_initial_delivery_pending')
          assert.deepEqual(restored, before)
        }
        assert.equal(calls, 1)
      } else {
        assert.deepEqual(await resume(), { answer: 'complete' })
        assert.equal(calls, 2)
        assert.equal(restored.initial_started, undefined)
      }
    })
  }
})
