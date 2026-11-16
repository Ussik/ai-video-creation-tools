import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { createSourceStoryDispatchGrant, hasSourceStoryCorrectionContinuation, isUnsentSourceStoryCorrection,
  isUnstartedSourceStoryTask, sourceStoryDispatchAuthorized, sourceStoryCorrectionDispatchAuthorized, sourceQualityCorrectionDispatchAuthorized,
  sourceQualityDispatchAuthorized, bindSourceQualityDispatchGrant } from '../src/modules/script/script-source-ordinary-dispatch.js'
import { sourceStoryResume } from '../src/modules/script/script-source-story-progress.js'
import { sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown) => hash(canonicalAiValue(value))
const fingerprint = (value: unknown) => hash(JSON.stringify(value))
function correction(contractName: string) {
  const base = hash('exact initial input'), prompt = 'frozen first correction', contract = { name: contractName, schema: { type: 'object' } }
  return { input_hash: base, raw: 'complete but invalid initial', original_raw: 'complete but invalid initial',
    correction_request: { base_input_hash: base, input_hash: fingerprint([prompt, contract]), prompt, contract } }
}
function fixture() {
  const document: Omit<ScriptSourceDocument, 'analysis'> = { project_id: 'p', filename: 'story.md', content: '完整原稿', updated_at: 'source-stamp' }
  const state: ScriptSourceAnalysis = { id: 'ordinary-initial-run', source_version: 'source', model_id: 'model', configuration_hash: 'configuration',
    status: 'queued', completed_chunks: 1, total_chunks: 1, sections: [], error: null, updated_at: 'stamp', phase: 'synthesis',
    story_work: { input_hash: 'work', tasks: [
      ...Array.from({ length: 16 }, (_, i) => ({ key: `preserved:${i}`, result: { preserved: i } })),
      { key: 'uncertainties:old', result: { preserved: 'validated' }, output_candidate: { context_hash: 'old', checkpoint: {
        raw: 'retained old original', correction_started: { input_hash: 'unknown-old-correction' } } } },
      { key: 'characters_merge:new', output_candidate: { context_hash: hash('new candidate'), replay_version: 1, checkpoint: {} } },
    ] } }
  const context = { document, state, configuration_hash: 'configuration', local_active: true, current_run_unknown: false }
  state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context)
  state.status = 'running'
  const task = state.story_work!.tasks.at(-1)!
  task.failure = { code: 'source_request_sibling_pending', message: 'first correction was not dispatched' }
  task.output_candidate!.checkpoint = correction('script_source_story_characters_merge')
  const cp = task.output_candidate!.checkpoint, frozen = cp.correction_request!
  const proof = { task_key: task.key, candidate_hash: task.output_candidate!.context_hash, base_input_hash: cp.input_hash!,
    initial_request_key: hash('exact initial managed request'), initial_response_hash: hash(cp.original_raw!),
    correction_input_hash: frozen.input_hash, request_key: digest([state.model_id, frozen.prompt, frozen.contract]) }
  return { context, task, cp, proof, initialRun: state.id }
}

test('a live ordinary initial owns only its exact first correction, including its producer-persisted matching dispatch marker', () => {
  const { context, task, cp, proof, initialRun } = fixture()
  assert.equal(isUnsentSourceStoryCorrection(task), true)
  assert.equal(sourceStoryCorrectionDispatchAuthorized(context, proof, initialRun), true)
  assert.equal(sourceStoryDispatchAuthorized(context, proof), false, 'saved initial bytes cannot become another initial POST')
  cp.correction_started = { input_hash: proof.correction_input_hash }
  assert.equal(isUnsentSourceStoryCorrection(task), false, 'a persisted uncertain marker is not eligible for a new grant')
  assert.equal(sourceStoryCorrectionDispatchAuthorized(context, proof, initialRun), true, 'the same live call reaches the final boundary with its marker already durable')
  cp.correction_started.input_hash = 'another correction'
  assert.equal(sourceStoryCorrectionDispatchAuthorized(context, proof, initialRun), false)
})

test('explicit continuation protects the saved initial while carrying only its unused exact correction origin across further resumes', () => {
  const { context, task, proof, initialRun } = fixture(), preserved = structuredClone(context.state.story_work!.tasks.slice(0, 17))
  for (const id of ['first-resume', 'second-resume']) {
    const previous = context.state.ordinary_story_dispatch!
    context.state.id = id
    context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous)
    assert.ok(context.state.ordinary_story_dispatch!.protected_task_keys.includes(task.key))
    assert.deepEqual(context.state.ordinary_story_dispatch!.correction_tasks, [{ task_key: task.key, candidate_hash: proof.candidate_hash,
      base_input_hash: proof.base_input_hash, initial_run_id: initialRun, initial_response_hash: proof.initial_response_hash }])
    assert.equal(sourceStoryCorrectionDispatchAuthorized(context, proof, initialRun), true)
    assert.equal(sourceStoryCorrectionDispatchAuthorized(context, proof, id), false)
    assert.equal(sourceStoryDispatchAuthorized(context, proof), false)
    assert.equal(hasSourceStoryCorrectionContinuation(context.state, task), true)
  }
  assert.deepEqual(context.state.story_work!.tasks.slice(0, 17), preserved)
})

test('fresh grants never replenish old, started, spent, changed or unowned correction candidates', async t => {
  const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['old protected task', f => { f.context.state.ordinary_story_dispatch!.protected_task_keys.push(f.task.key) }],
    ['unknown correction', f => { f.cp.correction_started = { input_hash: f.proof.correction_input_hash } }],
    ['used correction', f => { f.cp.correction = { input_hash: f.proof.correction_input_hash, raw: 'already purchased' } }],
    ['unknown initial', f => { f.cp.initial_started = { input_hash: f.cp.input_hash! } }],
    ['changed raw', f => { f.cp.raw += 'modified' }],
    ['changed frozen hash', f => { f.cp.correction_request!.input_hash = 'changed' }],
    ['changed source', f => { f.context.document.content += 'changed' }],
    ['changed config', f => { f.context.configuration_hash = 'changed' }],
    ['changed work', f => { f.context.state.story_work!.input_hash = 'changed' }],
  ]
  for (const [name, mutate] of changes) await t.test(name, () => {
    const f = fixture(); mutate(f)
    const previous = f.context.state.ordinary_story_dispatch
    f.context.state.id = 'new-run'
    f.context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(f.context, previous)
    assert.equal(f.context.state.ordinary_story_dispatch?.correction_tasks?.length || 0, 0)
    assert.equal(sourceStoryCorrectionDispatchAuthorized(f.context, f.proof, f.initialRun), false)
  })
})

test('derived correction authority rejects every changed proof, completed output and fresh-boundary identity', async t => {
  for (const key of ['task_key', 'candidate_hash', 'base_input_hash', 'initial_request_key', 'initial_response_hash', 'correction_input_hash', 'request_key'] as const) await t.test(key, () => {
    const f = fixture()
    const invalid = { ...f.proof, [key]: 'changed' }
    assert.equal(sourceStoryCorrectionDispatchAuthorized(f.context, invalid, f.initialRun), false)
  })
  for (const condition of ['result', 'inactive', 'paused', 'unknown sibling'] as const) await t.test(condition, () => {
    const f = fixture()
    if (condition === 'result') f.task.result = {}
    if (condition === 'inactive') f.context.local_active = false
    if (condition === 'paused') f.context.state.status = 'paused'
    if (condition === 'unknown sibling') {
      f.context.current_run_unknown = true
      f.context.state.story_work!.tasks.push({ key: 'timeline:failed', failure: { code: 'stream_lost', message: 'unknown' },
        output_candidate: { context_hash: 'sibling', checkpoint: { initial_started: { input_hash: 'unknown' } } } })
    }
    assert.equal(sourceStoryCorrectionDispatchAuthorized(f.context, f.proof, f.initialRun), false)
  })
})

test('public continuation first offers local revalidation of a saved new answer and preserves old and unknown correction barriers', () => {
  const f = fixture(); f.context.state.status = 'failed'
  assert.equal(sourceStoryResume(f.context.state)?.action, 'revalidate')
  assert.match(sourceStoryResume(f.context.state)!.message, /先在本地重新校验/)
  assert.match(sourceStoryResume(f.context.state)!.message, /不发送模型请求/)
  f.context.state.ordinary_story_dispatch!.protected_task_keys.push(f.task.key)
  assert.equal(sourceStoryResume(f.context.state)?.action, 'reconcile_request')
  f.context.state.ordinary_story_dispatch!.protected_task_keys.pop()
  f.cp.correction_started = { input_hash: f.proof.correction_input_hash }
  assert.equal(sourceStoryResume(f.context.state)?.action, 'reconcile_request')
})

test('a direct independent quality review keeps its unused correction across story-work removal and explicit resume without reopening its initial request', () => {
  const { context } = fixture()
  context.state.story = { summary: '总结', characters: [], timeline: [], threads: [], ending: { summary: '结束', section_ids: [0] }, uncertainties: [] }
  delete context.state.story_work
  bindSourceQualityDispatchGrant(context, 'work')
  const candidate = sourceQualityInputHash(context.state), cp = correction('script_source_quality'), frozen = cp.correction_request
  context.state.quality_work = { input_hash: candidate, checkpoint: { steps: {} }, output_checkpoint: cp }
  const proof = { task_key: 'quality:initial', candidate_hash: candidate, base_input_hash: cp.input_hash,
    initial_request_key: hash('quality initial request'), initial_response_hash: hash(cp.original_raw),
    correction_input_hash: frozen.input_hash, request_key: digest([context.state.model_id, frozen.prompt, frozen.contract]) }
  const initialRun = context.state.id
  assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, initialRun), true)
  assert.equal(sourceQualityDispatchAuthorized(context, { ...proof, task_key: 'quality:initial' }), false)
  const previous = context.state.ordinary_story_dispatch
  context.state.id = 'quality-resumed'
  context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(context, previous)
  assert.equal(context.state.ordinary_story_dispatch?.quality_input_hash, candidate)
  assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, initialRun), true)
  assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, context.state.id), false)
  cp.correction_started = { input_hash: frozen.input_hash }
  assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, initialRun), true)
  cp.correction = { input_hash: frozen.input_hash, raw: 'used correction' }
  assert.equal(sourceQualityCorrectionDispatchAuthorized(context, proof, initialRun), false)
})

test('a local-only missing response leaves a new empty task genuinely unstarted for the next explicit ordinary start', () => {
  const f = fixture()
  f.task.failure = { code: 'source_local_model_required', message: 'a new model response would be required; none was sent' }
  f.task.output_candidate!.checkpoint = { input_hash: hash('planned initial') }
  assert.equal(isUnstartedSourceStoryTask(f.task), true)
  f.context.state.id = 'explicit-after-local-check'
  f.context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(f.context)
  assert.equal(f.context.state.ordinary_story_dispatch!.protected_task_keys.includes(f.task.key), false)
  assert.equal(sourceStoryDispatchAuthorized(f.context, f.proof), true)
  f.task.output_candidate!.checkpoint.initial_started = { input_hash: hash('planned initial') }
  assert.equal(sourceStoryDispatchAuthorized(f.context, f.proof), true, 'the real first request may persist its own initial marker')
  assert.equal(isUnstartedSourceStoryTask(f.task), false, 'a new grant cannot reset a marker once an actual request begins')
  f.task.output_candidate!.checkpoint.raw = 'complete saved response'
  assert.equal(sourceStoryDispatchAuthorized(f.context, f.proof), false)
})

test('a local-only empty direct-quality shell does not permanently consume its first ordinary request', async t => {
  const shell = () => {
    const { context } = fixture()
    context.state.story = { summary: '总结', characters: [], timeline: [], threads: [], ending: { summary: '结束', section_ids: [0] }, uncertainties: [] }
    delete context.state.story_work
    const candidate = sourceQualityInputHash(context.state)
    context.state.quality_work = { input_hash: candidate, checkpoint: { steps: {} }, output_checkpoint: { input_hash: hash('planned quality input') } }
    return { context, candidate, work: context.state.quality_work }
  }
  const f = shell()
  f.context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(f.context)
  assert.equal(f.context.state.ordinary_story_dispatch?.quality_input_hash, f.candidate)
  assert.equal(sourceQualityDispatchAuthorized(f.context, { task_key: 'quality:initial', candidate_hash: f.candidate, request_key: hash('quality') }), true)
  const changes: Array<[string, (s: ReturnType<typeof shell>) => void]> = [
    ['saved raw', s => { s.work.output_checkpoint!.raw = 'retained answer' }],
    ['unknown initial', s => { s.work.output_checkpoint!.initial_started = { input_hash: s.work.output_checkpoint!.input_hash! } }],
    ['unknown correction', s => { s.work.output_checkpoint!.correction_started = { input_hash: 'correction' } }],
    ['used correction', s => { s.work.output_checkpoint!.correction = { input_hash: 'correction', raw: 'already purchased' } }],
    ['saved page', s => { s.work.checkpoint.steps.page = { input_hash: 'page', value: {} } }],
    ['changed quality input', s => { s.work.input_hash = 'changed' }],
  ]
  for (const [name, mutate] of changes) await t.test(name, () => {
    const s = shell(); mutate(s)
    s.context.state.ordinary_story_dispatch = createSourceStoryDispatchGrant(s.context)
    assert.equal(s.context.state.ordinary_story_dispatch?.quality_input_hash, undefined)
  })
})
