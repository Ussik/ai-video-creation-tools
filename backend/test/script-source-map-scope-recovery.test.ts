import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { recoverAdjacentSourceMapScope } from '../src/modules/script/script-source-map-scope-recovery.js'
import { generateSourceMapOutput } from '../src/modules/script/script-source-map-output.js'
import { resolveSourceSections, scriptSourcePassages, sourceMapSchema, workPassages } from '../src/modules/script/script-source-map.js'

const content = '第一场。林舟找到钥匙。第二场。沈月接过钥匙。第三场。林舟打开门。第四场。沈月归还钥匙。第五场。城市恢复。'
const passages = scriptSourcePassages(content), units = passages.flatMap(passage => passage.units)
const boundary = units[4]!.offset
const initial = sourceMapSchema.parse({ sections: [0, 2, 4, 6].map(id => ({ start_unit: id, title: units[id]!.text,
  episode_number: id / 2 + 1, summary: units[id + 1]!.text, characters: [],
  events: [{ summary: units[id + 1]!.text, evidence: { unit_id: id + 1 } }], continues_previous: false, open_threads: [] })) })
const makeState = (): ScriptSourceAnalysis => ({ id: 'analysis', source_version: 'same-source', model_id: 'same-model',
  pipeline_version: 6, status: 'failed', phase: 'reading', completed_chunks: 0, total_chunks: 2, completed_characters: 0,
  sections: [], error: 'prior scope failure', updated_at: 'now', work: [
    { offset: 0, length: boundary, depth: 0, result: structuredClone(initial), boundary_repair: { candidate_hash: 'old', diagnosis_hash: 'old', status: 'failed' } },
    { offset: boundary, length: content.length - boundary, depth: 0 },
  ] })
const nextPrompt = (state: ScriptSourceAnalysis, sections: ReturnType<typeof resolveSourceSections>['sections']) => JSON.stringify({
  full_source: content, page: state.completed_chunks + 2, previous_section: { title: sections.at(-1)!.title, episode_number: sections.at(-1)!.episode_number },
})
const signal = () => new AbortController().signal
function pageItems(checkpoint: NonNullable<NonNullable<ScriptSourceAnalysis['work']>[number]['output_checkpoint']>) {
  return Object.values(checkpoint.pages?.steps || {}).flatMap(step => (step.value as { items: unknown[] }).items)
}

test('adjacent overflow is retained once as a current map plus a private future prefix in one snapshot', () => {
  const state = makeState(), before = structuredClone(state)
  let saves = 0, snapshot: ScriptSourceAnalysis | undefined
  const recovered = recoverAdjacentSourceMapScope(state, passages, local => nextPrompt(state, local), () => { saves++; snapshot = structuredClone(state) })
  assert.equal(recovered, true)
  assert.equal(saves, 1)
  assert.deepEqual(state.work![0]!.result, { sections: initial.sections.slice(0, 2) })
  assert.deepEqual(state.work![0]!.scope_recovery!.candidate, initial)
  assert.equal(state.work![0]!.boundary_repair, undefined, 'the old impossible coordinate patch is no longer applied')
  assert.equal(state.work![1]!.result, undefined, 'a future prefix is not a complete directory page')
  const seed = state.work![1]!.output_checkpoint!.seed!
  assert.deepEqual(seed.sections, initial.sections.slice(2))
  const local = resolveSourceSections(sourceMapSchema.parse(state.work![0]!.result), workPassages(passages, state.work![0]!))
  assert.deepEqual(local.problems, [])
  assert.equal(seed.input_hash, createHash('sha256').update(nextPrompt(before, local.sections)).digest('hex'))
  assert.equal(state.completed_chunks, 0)
  assert.equal(state.completed_characters, 0)
  assert.deepEqual(state.sections, [], 'future facts remain private until the existing page validation and append run')
  assert.deepEqual(snapshot!.work![0]!.result, state.work![0]!.result)
  assert.deepEqual(snapshot!.work![1]!.output_checkpoint!.seed, seed, 'both halves are part of the same durable snapshot')
  assert.equal(recoverAdjacentSourceMapScope(state, passages, () => assert.fail('already relocated candidate must not be dispatched again'), () => assert.fail('no extra snapshot needed')), false)
})

test('a failed durable save rolls both page changes back without losing the original candidate', () => {
  const state = makeState(), before = structuredClone(state), cause = new Error('snapshot save unavailable')
  assert.throws(() => recoverAdjacentSourceMapScope(state, passages, local => nextPrompt(state, local), () => { throw cause }), issue => issue === cause)
  assert.deepEqual(state, before)
})

for (const problem of ['mixed-current-evidence', 'mixed-future-evidence', 'not-increasing', 'future-misses-first', 'more-than-adjacent',
  'no-next', 'future-result', 'future-raw', 'future-correction', 'future-pages', 'future-seed', 'revision-reuse'] as const) {
  test(`unsafe ${problem} preserves every candidate field and fails before persistence`, () => {
    const state = makeState(), result = state.work![0]!.result as typeof initial, next = state.work![1]!
    if (problem === 'mixed-current-evidence') result.sections[1]!.events[0]!.evidence.unit_id = 5
    if (problem === 'mixed-future-evidence') result.sections[2]!.events[0]!.evidence.unit_id = 1
    if (problem === 'not-increasing') result.sections[3]!.start_unit = 4
    if (problem === 'future-misses-first') result.sections[2]!.start_unit = 5
    if (problem === 'more-than-adjacent') {
      next.length = units[6]!.offset - next.offset
      state.work!.push({ offset: units[6]!.offset, length: content.length - units[6]!.offset, depth: 0 })
    }
    if (problem === 'no-next') state.work!.pop()
    if (problem === 'future-result') next.result = { sections: [initial.sections[2]] }
    if (problem === 'future-raw') next.output_checkpoint = { raw: 'original future candidate' }
    if (problem === 'future-correction') next.output_checkpoint = { correction: { input_hash: 'old', raw: '{}' } }
    if (problem === 'future-pages') next.output_checkpoint = { pages: { steps: {} } }
    if (problem === 'future-seed') next.output_checkpoint = { seed: { input_hash: 'old', sections: [] } }
    if (problem === 'revision-reuse') state.revision_reuse = { status: 'pending', input_hash: 'reuse', source_version: 'same-source',
      base_source_version: 'old', planned_pages: [1], reused_pages: [], reused_section_ids: [], reused_characters: 0 }
    const before = structuredClone(state)
    assert.throws(() => recoverAdjacentSourceMapScope(state, passages, () => assert.fail('unsafe candidate must not bind a future task'),
      () => assert.fail('unsafe candidate cannot overwrite the checkpoint')), issue => {
      assert.equal((issue as { code?: string }).code, 'source_map_scope_recovery_unsupported')
      return true
    })
    assert.deepEqual(state, before)
  })
}

test('unknown source IDs remain eligible for the original coordinate repair without a scope mutation', () => {
  const state = makeState(), result = state.work![0]!.result as typeof initial
  result.sections = result.sections.slice(0, 2)
  result.sections[1]!.start_unit = 9999
  const before = structuredClone(state)
  assert.equal(recoverAdjacentSourceMapScope(state, passages, () => assert.fail(), () => assert.fail()), false)
  assert.deepEqual(state, before)
})

test('prior-page source IDs remain eligible for the original coordinate repair without a scope mutation', () => {
  const state = makeState()
  state.completed_chunks = 1
  state.work![1]!.result = { sections: structuredClone(initial.sections.slice(2)) }
  const result = state.work![1]!.result as typeof initial
  result.sections[0]!.start_unit = 0
  const before = structuredClone(state)
  assert.equal(recoverAdjacentSourceMapScope(state, passages, () => assert.fail(), () => assert.fail()), false)
  assert.deepEqual(state, before)
})

test('a future seed dispatches only continuation and a restarted helper retains it after disconnect', async () => {
  const state = makeState()
  let boundPrompt = ''
  recoverAdjacentSourceMapScope(state, passages, local => { boundPrompt = nextPrompt(state, local); return boundPrompt }, () => {})
  const checkpoint = structuredClone(state.work![1]!.output_checkpoint!)
  let durable = structuredClone(checkpoint), calls = 0
  const interruption = new Error('next directory page disconnected')
  await assert.rejects(generateSourceMapOutput(boundPrompt, workPassages(passages, state.work![1]!), async (_request, contract) => {
    calls++
    assert.equal(contract!.name, 'script_source_map_page', 'the known prefix prevents another full-page generation')
    assert.equal(durable.seed, undefined, 'seed is cleared only in the durable pages snapshot')
    assert.deepEqual(pageItems(durable), initial.sections.slice(2), 'complete future facts are durable before dispatch')
    throw interruption
  }, { signal: signal(), checkpoint, persist: () => { durable = structuredClone(checkpoint) } }), issue => issue === interruption)
  assert.equal(calls, 1)
  const restored = structuredClone(durable)
  const remaining = sourceMapSchema.parse({ sections: [{ start_unit: 8, title: units[8]!.text, episode_number: 5, summary: units[9]!.text,
    characters: [], events: [{ summary: units[9]!.text, evidence: { unit_id: 9 } }] }] }).sections[0]!
  const result = await generateSourceMapOutput(boundPrompt, workPassages(passages, state.work![1]!), async (_request, contract) => {
    calls++
    assert.equal(contract!.name, 'script_source_map_page')
    return JSON.stringify({ items: [remaining], complete: true })
  }, { signal: signal(), checkpoint: restored, persist: () => {} })
  assert.equal(calls, 2)
  assert.deepEqual(result.sections, [...initial.sections.slice(2), remaining])
  assert.equal(resolveSourceSections(result, workPassages(passages, state.work![1]!)).problems.length, 0)
  assert.equal(state.work![1]!.result, undefined, 'output helper completion does not itself publish project analysis')
})

test('a stale future seed cannot be dropped or silently dispatched as a new full request', async () => {
  const state = makeState()
  recoverAdjacentSourceMapScope(state, passages, () => 'bound prompt', () => {})
  const checkpoint = structuredClone(state.work![1]!.output_checkpoint!), before = structuredClone(checkpoint)
  await assert.rejects(generateSourceMapOutput('different source or prompt', workPassages(passages, state.work![1]!), async () => assert.fail('stale seed cannot dispatch'),
    { signal: signal(), checkpoint, persist: () => assert.fail('stale seed cannot be overwritten') }), issue => (issue as { code?: string }).code === 'source_map_seed_conflict')
  assert.deepEqual(checkpoint, before)
})
