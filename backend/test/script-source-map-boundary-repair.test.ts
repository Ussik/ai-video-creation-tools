import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StateGraph } from '@langchain/langgraph'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { modelTaskPolicies, withModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import type { ModelResultEvent } from '../src/modules/generation/model-result-observation.js'
import { repairSourceMapBoundaries, type SourceMapBoundaryRepairCheckpoint } from '../src/modules/script/script-source-map-boundary-repair.js'
import { sourceMapBoundaryProblems, scriptSourcePassages, sourceMapSchema, sourceSectionRanges,
  type SourceMapResult } from '../src/modules/script/script-source-map.js'

const passages = scriptSourcePassages('标题。开端。甲到来。转折。乙离开。结尾。')
const section = (start_unit: number, title = `章节${start_unit}`) => ({ start_unit, title, episode_number: null,
  summary: `${title}的完整摘要`, characters: [{ name: '甲', description: '原有身份保持', evidence: { unit_id: 2 } }],
  events: [{ summary: '原有事件保持', evidence: { unit_id: 2 } }], continues_previous: false, open_threads: ['未决事项'] })
const candidate = (...starts: number[]) => sourceMapSchema.parse({ sections: starts.map((start, index) => section(start, `原章节${index}`)) })
const signal = () => new AbortController().signal
const patch = (starts: Array<{ section_index: number; start_unit: number }>, prefix_sections: SourceMapResult['sections'] = []) => JSON.stringify({ starts, prefix_sections })

test('valid directory runs real graph validation without model requests', async t => {
  const compile = StateGraph.prototype.compile
  let compiled = 0
  t.mock.method(StateGraph.prototype, 'compile', function (this: StateGraph<any>, ...args: Parameters<typeof compile>) {
    compiled++
    const graph = Reflect.apply(compile, this, args)
    assert.deepEqual(Object.keys(graph.getGraph().nodes).filter(name => !name.startsWith('__')).sort(),
      ['finish_boundaries', 'repair_boundaries', 'validate_boundaries'])
    return graph
  })
  const original = candidate(0, 3), result = await repairSourceMapBoundaries(original, passages, async () => { throw new Error('must not call') }, { signal: signal() })
  assert.equal(compiled, 1)
  assert.deepEqual(result, original)
})

test('boundary diagnostics distinguish missing first, duplicate, descending and outside page coordinates', () => {
  assert.equal(sourceMapBoundaryProblems(candidate(2, 4), passages)[0]!.kind, 'missing_first')
  for (const starts of [[0, 2, 2, 5], [0, 2, 1, 5]]) {
    const issues = sourceMapBoundaryProblems(candidate(...starts), passages)
    assert.equal(issues[0]!.kind, 'not_increasing')
    assert.equal(issues[0]!.section_index, 2)
    assert.equal(issues[0]!.previous_start, 2)
    assert.equal(issues[0]!.next_start, 5)
  }
  assert.equal(sourceMapBoundaryProblems(candidate(0, 999), passages)[0]!.kind, 'out_of_window')
  assert.deepEqual(sourceMapBoundaryProblems(candidate(0, 999, 5), passages).map(issue => issue.section_index), [1], 'an invalid predecessor must not authorize changes to its valid next neighbor')
  assert.throws(() => sourceSectionRanges(candidate(2), passages), /sections\.0\.start_unit=2.*要求首unit=0/)
})

test('missing prefix can add an explicit section while preserving every original byte-equivalent field', async () => {
  const original = candidate(2, 4), prefix = sourceMapSchema.parse({ sections: [section(0, '标题与开端')] }).sections
  let calls = 0, checkpoint: SourceMapBoundaryRepairCheckpoint | undefined
  const result = await repairSourceMapBoundaries(original, passages, async prompt => {
    calls++
    assert.match(prompt, /first_unit/)
    assert.match(prompt, /prefix_sections/)
    return patch([], prefix)
  }, { signal: signal(), onCheckpoint: value => { checkpoint = value } })
  assert.equal(calls, 1)
  assert.equal(result.sections[0]!.start_unit, 0)
  assert.equal(JSON.stringify(result.sections.slice(1)), JSON.stringify(original.sections))
  assert.equal(checkpoint?.status, 'completed')
  assert.deepEqual(original, candidate(2, 4), 'caller candidate is not mutated')
})

test('missing first coordinate can extend original first section without rewriting its content', async () => {
  const original = candidate(1, 4)
  const result = await repairSourceMapBoundaries(original, passages, async () => patch([{ section_index: 0, start_unit: 0 }]), { signal: signal() })
  const expected = structuredClone(original); expected.sections[0]!.start_unit = 0
  assert.equal(JSON.stringify(result), JSON.stringify(expected))
})

test('a boundary coordinate-only answer needs no extra model correction for its omitted no-op prefix array', async () => {
  const original = candidate(1, 4), expected = structuredClone(original)
  expected.sections[0]!.start_unit = 0
  let calls = 0
  const result = await repairSourceMapBoundaries(original, passages, async () => {
    assert.equal(++calls, 1, 'an omitted no-op array must not consume another correction')
    return JSON.stringify({ starts: [{ section_index: 0, start_unit: 0 }] })
  }, { signal: signal() })
  assert.deepEqual(result, expected)
  assert.deepEqual(original, candidate(1, 4))
})

test('schema evolution replays an exact completed legacy boundary answer without dispatching a new schema', async () => {
  const original = candidate(1, 4), expected = structuredClone(original)
  expected.sections[0]!.start_unit = 0
  let reads = 0
  const generate: StructuredGenerator = async () => assert.fail('completed old boundary answer must not buy a new-schema request')
  generate.readCompleted = async (_prompt, contract) => {
    reads++
    const prefix = (contract!.schema.properties as any).prefix_sections
    assert.equal(prefix.items.properties.characters.items.properties.description.maxLength, 160)
    return JSON.stringify({ starts: [{ section_index: 0, start_unit: 0 }] })
  }
  assert.deepEqual(await repairSourceMapBoundaries(original, passages, generate, { signal: signal() }), expected)
  assert.equal(reads, 1)
})

test('an invalid or unknown retained legacy boundary answer never falls through to a new paid request', async () => {
  for (const kind of ['domain', 'format', 'unknown'] as const) {
    const original = candidate(1, 4)
    let reads = 0
    const generate: StructuredGenerator = async () => assert.fail('retained failure cannot authorize a new request')
    generate.readCompleted = async () => {
      if (kind === 'unknown') throw Object.assign(new Error('上次请求受理未知'), { statusCode: 409 })
      if (++reads > 1) return undefined
      return JSON.stringify(kind === 'domain' ? { starts: [{ section_index: 0, start_unit: 9999 }] } : { starts: 'invalid' })
    }
    await assert.rejects(repairSourceMapBoundaries(original, passages, generate, { signal: signal() }))
    assert.deepEqual(original, candidate(1, 4))
  }
})

test('a completed-only legacy miss permits the ordinary new boundary path exactly once', async () => {
  let calls = 0, reads = 0
  const generate: StructuredGenerator = async () => { calls++; return patch([{ section_index: 0, start_unit: 0 }]) }
  generate.readCompleted = async () => { reads++; return undefined }
  const result = await repairSourceMapBoundaries(candidate(1, 4), passages, generate, { signal: signal() })
  assert.equal(reads, 1); assert.equal(calls, 1)
  assert.equal(result.sections[0]!.start_unit, 0)
})

for (const [name, starts, index, corrected] of [
  ['duplicate', [0, 2, 2, 5], 2, 4], ['descending', [0, 2, 1, 5], 2, 4], ['outside', [0, 999, 5], 1, 3],
] as const) test(`repairs ${name} coordinate only and keeps adjacent valid boundaries and facts`, async () => {
  const original = candidate(...starts), expected = structuredClone(original)
  expected.sections[index]!.start_unit = corrected
  let calls = 0
  const result = await repairSourceMapBoundaries(original, passages, async () => { calls++; return patch([{ section_index: index, start_unit: corrected }]) }, { signal: signal() })
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(result), JSON.stringify(expected))
})

test('failed authorized patch is checkpointed and cannot consume more requests automatically', async () => {
  const original = candidate(0, 2, 2, 5)
  let checkpoint: SourceMapBoundaryRepairCheckpoint | undefined, calls = 0
  const generate = async () => { calls++; return patch([{ section_index: 2, start_unit: 1 }]) }
  await assert.rejects(repairSourceMapBoundaries(original, passages, generate, { signal: signal(), onCheckpoint: value => { checkpoint = value } }), /前一边界=2/)
  assert.equal(checkpoint?.status, 'failed')
  await assert.rejects(repairSourceMapBoundaries(original, passages, generate, { signal: signal(), checkpoint }), /目录边界定点修复未完成/)
  assert.equal(calls, 1)
})

test('unauthorized fields, duplicate index and invalid neighbor crossing cannot be applied', async () => {
  const original = candidate(0, 2, 2, 5)
  for (const starts of [[{ section_index: 1, start_unit: 1 }], [{ section_index: 2, start_unit: 3 }, { section_index: 2, start_unit: 4 }], [{ section_index: 2, start_unit: 5 }]]) {
    await assert.rejects(repairSourceMapBoundaries(original, passages, async () => patch(starts), { signal: signal() }), /未授权|重复|边界|契约/)
  }
  assert.deepEqual(original, candidate(0, 2, 2, 5))
})

test('completed patch and prepared dispatch barrier replay without provider requests', async () => {
  const original = candidate(0, 999, 5)
  let checkpoint: SourceMapBoundaryRepairCheckpoint | undefined
  const first = await repairSourceMapBoundaries(original, passages, async () => patch([{ section_index: 1, start_unit: 3 }]),
    { signal: signal(), onCheckpoint: value => { checkpoint = value } })
  const never = async () => { throw new Error('must not dispatch') }
  assert.deepEqual(await repairSourceMapBoundaries(original, passages, never, { signal: signal(), checkpoint }), first)
  await assert.rejects(repairSourceMapBoundaries(original, passages, never, { signal: signal(), checkpoint: { ...checkpoint!, status: 'prepared', patch: undefined } }), /停止重复派发/)
})

test('cancellation before or during repair does not accept a candidate or dispatch a replay', async () => {
  const controller = new AbortController(), original = candidate(1, 4)
  controller.abort()
  let calls = 0
  await assert.rejects(repairSourceMapBoundaries(original, passages, async () => { calls++; return patch([]) }, { signal: controller.signal }), /abort/i)
  assert.equal(calls, 0)
  const active = new AbortController()
  let checkpoint: SourceMapBoundaryRepairCheckpoint | undefined, accepted = false
  await assert.rejects(repairSourceMapBoundaries(original, passages, async () => {
    calls++; active.abort(); return patch([{ section_index: 0, start_unit: 0 }])
  }, { signal: active.signal, onCheckpoint: value => { checkpoint = value }, onCandidate: () => { accepted = true } }), /abort/i)
  assert.equal(checkpoint?.status, 'prepared')
  assert.equal(accepted, false)
  assert.equal(calls, 1)
})


test('patch cannot overwrite source prose through extra fields', async () => {
  const original = candidate(1, 4)
  await assert.rejects(repairSourceMapBoundaries(original, passages, async () => JSON.stringify({
    prefix_sections: [], starts: [{ section_index: 0, start_unit: 0, title: '试图重写' }],
  }), { signal: signal() }), /多余字段|契约/)
  assert.deepEqual(original, candidate(1, 4))
})

test('changed page text cannot reuse a completed repair from another input', async () => {
  const original = candidate(1, 4)
  let checkpoint: SourceMapBoundaryRepairCheckpoint | undefined, calls = 0
  const generate = async () => { calls++; return patch([{ section_index: 0, start_unit: 0 }]) }
  await repairSourceMapBoundaries(original, passages, generate, { signal: signal(), onCheckpoint: value => { checkpoint = value } })
  await repairSourceMapBoundaries(original, scriptSourcePassages('新题。开端。甲到来。转折。乙离开。结尾。'), generate, { signal: signal(), checkpoint })
  assert.equal(calls, 2)
})

type RepairContext = { first_unit: number; last_unit: number; repair_windows: Array<{ first_unit: number; last_unit: number }>;
  units: Array<{ id: number; text: string }>; targets: Array<{ section_index: number; allowed_unit_ids: number[] }> }
function contextFor(prompt: string): RepairContext {
  const marker = '【目录边界定点修复】\n'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}

test('missing opening sends the complete affected prefix and excludes unrelated later manuscript text', async () => {
  const text = '标题。开端。甲到来。转折。乙离开。结尾。不相关尾部MARKER。'
  const local = scriptSourcePassages(text), units = local.flatMap(p => p.units)
  const original = candidate(2, 4)
  await repairSourceMapBoundaries(original, local, async prompt => {
    const context = contextFor(prompt)
    assert.equal(context.first_unit, 0); assert.equal(context.last_unit, units.at(-1)!.id)
    assert.deepEqual(context.units.map(unit => unit.id), [0, 1, 2, 3])
    assert.equal(context.units.map(unit => unit.text).join(''), units.slice(0, 4).map(unit => unit.text).join(''))
    assert.doesNotMatch(prompt, /不相关尾部MARKER|乙离开|结尾/)
    assert.match(prompt, /完整待修复范围/)
    return patch([{ section_index: 0, start_unit: 0 }])
  }, { signal: signal() })
})

test('local source compacts blank lines while preserving every character and only visible allowed IDs', async () => {
  const text = '标题。\n\n开端。\n\n甲到来。\n\n转折。\n\n不相关尾部MARKER。'
  const local = scriptSourcePassages(text), units = local.flatMap(p => p.units)
  const body = units.find(unit => unit.text.includes('甲到来'))!, next = units.find(unit => unit.text.includes('转折'))!
  const original = candidate(body.id, next.id)
  for (const item of [...original.sections[0]!.characters, ...original.sections[0]!.events]) item.evidence.unit_id = body.id
  await repairSourceMapBoundaries(original, local, async prompt => {
    const context = contextFor(prompt), selected = units.filter(unit => unit.id < next.id)
    assert.equal(context.units.map(unit => unit.text).join(''), selected.map(unit => unit.text).join(''))
    assert.ok(context.units.length < selected.length)
    const visible = new Set(context.units.map(unit => unit.id))
    assert.ok(context.targets.every(target => target.allowed_unit_ids.every(id => visible.has(id))))
    assert.ok(visible.has(body.id), 'original target evidence is not hidden by blank-line compaction')
    assert.doesNotMatch(prompt, /不相关尾部MARKER/)
    return patch([{ section_index: 0, start_unit: 0 }])
  }, { signal: signal() })
})

test('multiple damaged boundaries send the union of local ranges and retain distant target evidence without filling unrelated gaps', async () => {
  const text = Array.from({ length: 13 }, (_, index) => index === 6 ? '不相关中段MARKER。' : index === 12 ? '不相关尾部MARKER。' : `原文${index}。`).join('')
  const local = scriptSourcePassages(text), units = local.flatMap(p => p.units), original = candidate(0, 2, 2, 5, 7, 7, 10)
  original.sections[2]!.characters[0]!.evidence.unit_id = 3
  original.sections[2]!.events[0]!.evidence.unit_id = 3
  original.sections[5]!.characters[0]!.evidence.unit_id = 8
  original.sections[5]!.events[0]!.evidence.unit_id = 0
  const result = await repairSourceMapBoundaries(original, local, async prompt => {
    const context = contextFor(prompt)
    assert.deepEqual(context.units.map(unit => unit.id), [0, 2, 3, 4, 7, 8, 9])
    assert.equal(context.units.find(unit => unit.id === 0)!.text, units[0]!.text, 'distant target evidence remains an intact original unit')
    assert.doesNotMatch(prompt, /不相关中段MARKER|不相关尾部MARKER/)
    assert.deepEqual(context.targets.map(target => target.allowed_unit_ids), [[3, 4], [8, 9]])
    assert.deepEqual(context.repair_windows.flatMap(window => Array.from({ length: window.last_unit - window.first_unit + 1 }, (_, i) => window.first_unit + i)), [0, 2, 3, 4, 7, 8, 9])
    return patch([{ section_index: 2, start_unit: 4 }, { section_index: 5, start_unit: 9 }])
  }, { signal: signal() })
  assert.deepEqual(result.sections.map(section => section.start_unit), [0, 2, 4, 5, 7, 9, 10])
})

test('consecutive bad boundaries share the complete range between nearest preserved neighbors', async () => {
  const text = '原文0。原文1。原文2。原文3。原文4。原文5。不相关尾部MARKER。原文7。'
  const local = scriptSourcePassages(text), original = candidate(0, 2, 1, 0, 5, 7)
  for (const [index, evidence] of [[2, 3], [3, 4]]) {
    original.sections[index]!.characters[0]!.evidence.unit_id = evidence!
    original.sections[index]!.events[0]!.evidence.unit_id = evidence!
  }
  const result = await repairSourceMapBoundaries(original, local, async prompt => {
    const context = contextFor(prompt)
    assert.deepEqual(context.targets.map(target => target.allowed_unit_ids), [[3, 4], [3, 4]])
    assert.deepEqual(context.units.map(unit => unit.id), [0, 1, 2, 3, 4], 'bad original starts remain visible even before the protected left neighbor')
    assert.doesNotMatch(prompt, /不相关尾部MARKER/)
    return patch([{ section_index: 2, start_unit: 3 }, { section_index: 3, start_unit: 4 }])
  }, { signal: signal() })
  assert.deepEqual(result.sections.map(section => section.start_unit), [0, 2, 3, 4, 5, 7])
})


test('boundary diagnostics report actual business validation and successful repair without exporting prose', async () => {
  const results: ModelResultEvent[] = []
  await withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => { results.push(event) } }, () =>
    repairSourceMapBoundaries(candidate(1, 4), passages, async () => patch([{ section_index: 0, start_unit: 0 }]), { signal: signal() }))
  assert.deepEqual(results.filter(event => event.status === 'invalid_business'),
    [{ phase: 'structure', stage: 'source_analysis', status: 'invalid_business', issue_count: 1 }])
  assert.deepEqual(results.filter(event => event.repaired),
    [{ phase: 'structure', stage: 'content_repair', status: 'valid', issue_count: 0, repaired: true, repair_effect: 'improved' }])
  assert.doesNotMatch(JSON.stringify(results), /原章节|原有事件|完整摘要|标题/)
})

test('invalid boundary patch reports unchanged business failure, while transport and cancellation do not', async () => {
  for (const kind of ['business', 'transport', 'cancel'] as const) {
    const results: ModelResultEvent[] = [], controller = new AbortController()
    await assert.rejects(withModelRequestContext({ policy: modelTaskPolicies.generation, onResult: event => { results.push(event) } }, () =>
      repairSourceMapBoundaries(candidate(1, 4), passages, async () => {
        if (kind === 'transport') throw new Error('service unavailable')
        if (kind === 'cancel') controller.abort()
        return patch([])
      }, { signal: controller.signal })))
    const repaired = results.filter(event => event.repaired)
    assert.deepEqual(repaired, kind === 'business'
      ? [{ phase: 'structure', stage: 'content_repair', status: 'invalid_business', issue_count: 1, repaired: true, repair_effect: 'unchanged' }] : [])
  }
})


for (const [label, starts] of [['empty allowed range', [0, 0, 1]], ['insufficient coordinates for consecutive targets', [0, 2, 1, 0, 4]]] as const) {
  test(`${label} stops before a prepared dispatch or model call`, async () => {
    const original = candidate(...starts), checkpoints: SourceMapBoundaryRepairCheckpoint[] = []
    let calls = 0
    const generate = async () => { calls++; throw new Error('unsatisfiable coordinates must not dispatch') }
    await assert.rejects(repairSourceMapBoundaries(original, passages, generate,
      { signal: signal(), onCheckpoint: value => { checkpoints.push(value) } }), /保留合法邻居边界.*没有足够.*未发送模型请求/)
    assert.equal(calls, 0)
    assert.deepEqual(checkpoints.map(checkpoint => checkpoint.status), ['failed'])
    assert.deepEqual(original, candidate(...starts))
    await assert.rejects(repairSourceMapBoundaries(original, passages, generate,
      { signal: signal(), checkpoint: checkpoints[0] }), /没有足够.*未发送模型请求/)
    assert.equal(calls, 0)
  })
}

test('feasible consecutive targets still receive one model request and preserve their neighbors', async () => {
  const original = candidate(0, 2, 1, 0, 5)
  let calls = 0
  const result = await repairSourceMapBoundaries(original, passages, async () => {
    calls++
    return patch([{ section_index: 2, start_unit: 3 }, { section_index: 3, start_unit: 4 }])
  }, { signal: signal() })
  assert.equal(calls, 1)
  assert.deepEqual(result.sections.map(section => section.start_unit), [0, 2, 3, 4, 5])
  assert.equal(JSON.stringify(result.sections[1]), JSON.stringify(original.sections[1]))
  assert.equal(JSON.stringify(result.sections[4]), JSON.stringify(original.sections[4]))
})
