import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { SourceQualityProposalState } from '../src/modules/script/script-source-quality-repair.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-quality-repair-replay-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { repairSourceQuality, sourceQualityRepairProgress } = await import('../src/modules/script/script-source-quality-repair.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { scriptSourcePassages } = await import('../src/modules/script/script-source-map.js')
initDb()
db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('quality-replay', 'quality replay fixture', now(), now())
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

const project = 'quality-replay'
const signal = () => new AbortController().signal
const contract = { name: 'script_source_quality_repair', schema: { type: 'object', properties: { status: { type: 'string' } } } }
const invoke = (wrapped: ReturnType<typeof sourceModelRecovery>, prompt = 'same initial finding and baseline', shape = contract, model = 'same-model') =>
  wrapped(project, model, prompt, shape, signal())

test('explicit compatible lineage inherits an exact initial quality repair once and promotes it for reconstruction', async () => {
  const identity = { source: 'quality-initial-exact', model: 'm', configuration: 'same' }
  let calls = 0
  const generate = async () => `complete repair ${++calls}`
  const output = await invoke(sourceModelRecovery(project, 'quality-original', identity, generate))
  const continued = sourceModelRecovery(project, 'quality-continued', identity, generate, { completedStoryRunIds: ['quality-original'] })
  assert.equal(await invoke(continued), output)
  assert.equal(calls, 1)
  assert.equal(await invoke(sourceModelRecovery(project, 'quality-continued', identity, generate)), output)
  assert.equal(calls, 1)
  assert.equal(await invoke(continued), 'complete repair 2')
  assert.equal(calls, 2, 'repeat work in a live wrapper is not cached indefinitely')
})

test('quality inheritance excludes absent lineage, structure and local repairs, and same-name full format correction', async t => {
  for (const mode of ['no lineage', 'wrong lineage', 'structure repair', 'local repair', 'format correction'] as const) await t.test(mode, async () => {
    const identity = { source: `quality-excluded-${mode}` }
    let calls = 0
    const generate = async () => `reply ${++calls}`
    const shape = mode === 'structure repair' ? { ...contract, name: 'script_source_quality_repair_structure_repair' }
      : mode === 'local repair' ? { ...contract, name: 'script_source_quality_repair_local_repair' } : contract
    const prompt = mode === 'format correction' ? 'original task\n【一次格式修正】\nfix the previous complete result' : undefined
    const original = `excluded-${mode}-original`
    await invoke(sourceModelRecovery(project, original, identity, generate), prompt, shape)
    const options = mode === 'no lineage' ? {} : { completedStoryRunIds: [mode === 'wrong lineage' ? 'unrelated' : original] }
    assert.equal(await invoke(sourceModelRecovery(project, `excluded-${mode}-next`, identity, generate, options), prompt, shape), 'reply 2')
    assert.equal(calls, 2)
  })
})

test('initial quality repair cannot cross finding, prompt, schema, source, model or configuration identity', async t => {
  for (const mode of ['finding', 'prompt', 'schema', 'source', 'model', 'configuration'] as const) await t.test(mode, async () => {
    const identity = { source: `quality-key-${mode}`, model: 'configured-model', configuration: 'same' }
    let calls = 0
    const generate = async () => `reply ${++calls}`
    const original = `quality-key-${mode}-original`
    const originalPrompt = JSON.stringify({ finding: { kind: 'causality', unit_ids: [1] }, source: 'exact manuscript' })
    await invoke(sourceModelRecovery(project, original, identity, generate), originalPrompt)
    const nextIdentity = mode === 'source' ? { ...identity, source: 'new source version' }
      : mode === 'configuration' ? { ...identity, configuration: 'changed' } : identity
    const prompt = mode === 'finding' ? JSON.stringify({ finding: { kind: 'omission', unit_ids: [2] }, source: 'exact manuscript' })
      : mode === 'prompt' ? originalPrompt + '\nnew instruction' : originalPrompt
    const shape = mode === 'schema' ? { ...contract, schema: { type: 'object', properties: { reason: { type: 'string' } } } } : contract
    const next = sourceModelRecovery(project, `quality-key-${mode}-next`, nextIdentity, generate, { completedStoryRunIds: [original] })
    assert.equal(await invoke(next, prompt, shape, mode === 'model' ? 'changed-model' : 'same-model'), 'reply 2')
    assert.equal(calls, 2)
  })
})

test('initial quality inheritance retains unknown-dispatch and failed-promotion barriers', async () => {
  const identity = { source: 'quality-unknown-barrier' }
  let posts = 0
  const unknown = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; throw new Error('accepted response lost') }
  await assert.rejects(invoke(sourceModelRecovery(project, 'quality-unknown-original', identity, unknown)), /lost/)
  await assert.rejects(invoke(sourceModelRecovery(project, 'quality-unknown-next', identity, unknown,
    { completedStoryRunIds: ['quality-unknown-original'] })), /不能自动重新生成/)
  assert.equal(posts, 1)

  const completeIdentity = { source: 'quality-promotion-barrier' }
  let calls = 0
  const complete = async () => { calls++; return 'saved complete quality repair' }
  await invoke(sourceModelRecovery(project, 'quality-promotion-original', completeIdentity, complete))
  db.exec("CREATE TRIGGER reject_quality_promotion BEFORE UPDATE ON source_model_requests WHEN NEW.run_id='quality-promotion-next' BEGIN SELECT RAISE(ABORT,'fixture quality promotion failure'); END")
  try {
    await assert.rejects(invoke(sourceModelRecovery(project, 'quality-promotion-next', completeIdentity, complete,
      { completedStoryRunIds: ['quality-promotion-original'] })), /promotion failure/)
    assert.equal(calls, 1)
  } finally { db.exec('DROP TRIGGER reject_quality_promotion') }
})

test('quality initial replies remain excluded from the completed part reader', async () => {
  const identity = { source: 'quality-reader-excluded' }
  let calls = 0
  const generate = async () => { calls++; return 'saved complete quality repair' }
  await invoke(sourceModelRecovery(project, 'quality-reader-original', identity, generate))
  const next = sourceModelRecovery(project, 'quality-reader-next', identity, generate, { completedStoryRunIds: ['quality-reader-original'] })
  assert.equal(await next.readCompleted!(project, 'same-model', 'same initial finding and baseline', contract, signal()), undefined)
  assert.equal(calls, 1)
})

const document = { filename: 'continuation.txt', content: '第一集\n林舟守约。\n' }
const units = scriptSourcePassages(document.content).flatMap(passage => passage.units)
const unit = units.find(item => item.text.includes('林舟'))!
function stateFor(): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'fixture-analysis', source_version: 'source-v1', model_id: 'same-model', status: 'failed', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, completed_characters: document.content.length, error: 'fixture interruption', updated_at: 'fixture',
    sections: [{ offset: 0, length: document.content.length, unit_id: 0, title: '第一集', episode_number: 1, summary: '林舟守约',
      characters: [{ name: '林舟', description: '守约的人', evidence: { offset: unit.offset, quote: unit.text } }], events: [], open_threads: [] }],
    story: { summary: '林舟守约', characters: [{ name: '林舟', aliases: [], description: '守约的人', section_ids: [0] }],
      timeline: [{ summary: '林舟守约', section_ids: [0] }], threads: [], ending: { summary: '约定履行', section_ids: [0] }, uncertainties: [] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: 'causality', explanation: '核对守约事件的表述', unit_ids: [unit.id] }] }
  return state
}

test('real structural repair resumes from inherited initial raw and reruns full schema and business validation', async t => {
  for (const mode of ['valid', 'stale expected', 'unknown section'] as const) await t.test(mode, async () => {
    const state = stateFor(), original = structuredClone(state), requests: string[] = []
    const identity = { source: `quality-structural-continuation-${mode}`, model: 'same-model', configuration: 'same' }
    const originalRun = `quality-structural-${mode}-original`
    const raw = JSON.stringify({ status: 'patched', reason: '按原文修补当前问题', changes: [
      { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: original.story!.summary, value: '林舟依约行事' },
      { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
        expected: mode === 'stale expected' ? { summary: '并非原值', section_ids: [0] } : original.story!.timeline[0],
        value: { summary: '补'.repeat(621), section_ids: mode === 'unknown section' ? [999] : [0] } },
    ] })
    const first = sourceModelRecovery(project, originalRun, identity, async (_project, _model, _prompt, shape) => {
      requests.push(`first:${shape!.name}`)
      if (shape!.name === 'script_source_quality_repair') return raw
      throw Object.assign(new Error('fixture stop before correction dispatch'), { delivery: 'not_sent' })
    })
    await assert.rejects(repairSourceQuality(document, state, (prompt, shape) => first(project, 'same-model', prompt, shape, signal()),
      () => {}, signal()), /fixture stop before correction dispatch/)
    assert.deepEqual(state.story, original.story)
    assert.equal(sourceQualityRepairProgress(state), 0)
    const before = db.prepare("SELECT result FROM source_model_requests WHERE project_id=? AND run_id=? AND state='completed'").all(project, originalRun) as Array<{ result: string }>
    assert.deepEqual(before.map(row => row.result), [raw], 'only the full initial raw is durably complete')

    const next = sourceModelRecovery(project, `quality-structural-${mode}-next`, identity, async (_project, _model, prompt, shape) => {
      requests.push(`next:${shape!.name}`)
      assert.equal(shape!.name, 'script_source_quality_repair_structure_repair', 'the completed initial request must not be regenerated')
      assert.match(prompt, /"path":\["changes",1,"value","summary"\]/)
      const repairs = (shape!.schema.properties as any).repairs
      assert.deepEqual(repairs.properties.repair_0, { type: 'string', minLength: 1, maxLength: 600 })
      assert.deepEqual(state.story, original.story, 'no candidate is adopted before complete validation')
      return JSON.stringify({ repairs: { repair_0: '林舟依约守诺' } })
    }, { completedStoryRunIds: [originalRun] })
    const resumed = repairSourceQuality(document, state, (prompt, shape) => next(project, 'same-model', prompt, shape, signal()), () => {}, signal())
    if (mode === 'valid') {
      await resumed
      assert.equal(sourceQualityRepairProgress(state), 1)
      assert.deepEqual(state.story, { ...original.story, summary: '林舟依约行事', timeline: [{ summary: '林舟依约守诺', section_ids: [0] }] })
      assert.deepEqual(state.quality, original.quality, 'a fresh independent review is still required')
    } else {
      await assert.rejects(resumed, mode === 'stale expected' ? /原值不匹配/ : /不存在的章节/)
      assert.equal(sourceQualityRepairProgress(state), 0)
      assert.deepEqual(state.story, original.story)
    }
    assert.deepEqual(state.sections, original.sections)
    assert.equal(document.content, '第一集\n林舟守约。\n')
    assert.deepEqual(requests, ['first:script_source_quality_repair', 'first:script_source_quality_repair_structure_repair',
      'next:script_source_quality_repair_structure_repair'])
  })
})


test('an inherited complete quality proposal reconstructs one business correction without regenerating valid siblings', async () => {
  const state = stateFor(), original = structuredClone(state), requests: string[] = []
  const identity = { source: 'quality-local-continuation', model: 'same-model', configuration: 'same' }
  const raw = JSON.stringify({ status: 'patched', reason: '按原文修补当前问题', changes: [
    { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: original.story!.summary, value: '林舟依约行事' },
    { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
      expected: { summary: '并非原值', section_ids: [0] }, value: { summary: '林舟依约守诺', section_ids: [0] } },
  ] })
  const first = sourceModelRecovery(project, 'quality-local-original', identity, async (_project, _model, _prompt, shape) => {
    requests.push(`first:${shape!.name}`)
    if (shape!.name === 'script_source_quality_repair') return raw
    throw Object.assign(new Error('fixture stop before local correction dispatch'), { delivery: 'not_sent' })
  })
  await assert.rejects(repairSourceQuality(document, state, (prompt, shape) => first(project, 'same-model', prompt, shape, signal()),
    () => {}, signal()), /fixture stop before local correction dispatch/)
  assert.deepEqual(state.story, original.story); assert.equal(sourceQualityRepairProgress(state), 0)
  const next = sourceModelRecovery(project, 'quality-local-next', identity, async (_project, _model, prompt, shape) => {
    requests.push(`next:${shape!.name}`)
    assert.equal(shape!.name, 'script_source_quality_repair_local_repair')
    assert.deepEqual(Object.keys((shape!.schema.properties as any).repairs.properties), ['change_1'])
    assert.ok(!prompt.includes('【原稿分析定点修补资料】'))
    assert.deepEqual(state.story, original.story)
    return JSON.stringify({ repairs: { change_1: { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
      expected: original.story!.timeline[0], value: { summary: '林舟依约守诺', section_ids: [0] } } } })
  }, { completedStoryRunIds: ['quality-local-original'] })
  await repairSourceQuality(document, state, (prompt, shape) => next(project, 'same-model', prompt, shape, signal()), () => {}, signal())
  assert.equal(sourceQualityRepairProgress(state), 1)
  assert.deepEqual(state.story, { ...original.story, summary: '林舟依约行事', timeline: [{ summary: '林舟依约守诺', section_ids: [0] }] })
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.quality, original.quality)
  assert.deepEqual(requests, ['first:script_source_quality_repair', 'first:script_source_quality_repair_local_repair',
    'next:script_source_quality_repair_local_repair'])
})

test('a durable unknown local correction stops exact continuation and configuration drift cannot overwrite its protected proposal', async () => {
  const state: SourceQualityProposalState = stateFor(), original = structuredClone(state)
  const identity = { source: 'quality-durable-unknown', model: 'same-model', configuration: 'same' }
  const changes = [
    { target: 'story.summary', section_id: null, operation: 'replace', index: null, expected: original.story!.summary, value: '林舟依约行事' },
    { target: 'story.timeline', section_id: null, operation: 'replace', index: 0,
      expected: { summary: '并非原值', section_ids: [0] }, value: { summary: '林舟依约守诺', section_ids: [0] } },
  ]
  const raw = JSON.stringify({ status: 'patched', reason: '按原文修补当前问题', changes })
  const unknown = Object.assign(new Error('local correction response unknown'), { delivery: 'unknown', code: 'upstream_request_interrupted', failure_stage: 'body' })
  let firstCalls = 0
  const first = sourceModelRecovery(project, 'quality-durable-unknown-first', identity, async (_project, _model, _prompt, shape) => {
    firstCalls++
    if (shape!.name === 'script_source_quality_repair') return raw
    assert.equal(shape!.name, 'script_source_quality_repair_local_repair')
    notifyTextRequest('dispatch', { delivery: 'unknown' })
    throw unknown
  })
  const saved: SourceQualityProposalState[] = []
  await assert.rejects(repairSourceQuality(document, state, (prompt, shape) => first(project, 'same-model', prompt, shape, signal()),
    () => { saved.push(structuredClone(state)) }, signal()), error => error === unknown)
  assert.equal(firstCalls, 2)
  assert.deepEqual(state.story, original.story); assert.deepEqual(state.sections, original.sections)
  assert.equal(sourceQualityRepairProgress(state), 0)
  assert.ok(saved.at(-1)!.quality_repair_output!.checkpoint.correction_started)
  assert.equal(saved.at(-1)!.quality_repair_output!.checkpoint.raw, raw)
  const recovered = JSON.parse(JSON.stringify(saved.at(-1))) as SourceQualityProposalState
  let nextCalls = 0
  const next = sourceModelRecovery(project, 'quality-durable-unknown-next', identity, async () => {
    nextCalls++; throw new Error('an unknown correction must not dispatch twice')
  }, { completedStoryRunIds: ['quality-durable-unknown-first'] })
  await assert.rejects(repairSourceQuality(document, recovered, (prompt, shape) => next(project, 'same-model', prompt, shape, signal()), () => {}, signal()),
    (error: any) => error.code === 'structured_correction_exhausted')
  assert.equal(nextCalls, 0)
  assert.deepEqual(recovered.story, original.story); assert.deepEqual(recovered.sections, original.sections)
  const protectedOutput = structuredClone(recovered.quality_repair_output)
  recovered.configuration_hash = 'explicit-config-v2'
  let configuredCalls = 0
  const configured = sourceModelRecovery(project, 'quality-durable-unknown-configured', { ...identity, configuration: 'explicit-config-v2' }, async (_project, _model, _prompt, shape) => {
    configuredCalls++; assert.equal(shape!.name, 'script_source_quality_repair')
    assert.deepEqual(recovered.story, original.story); assert.deepEqual(recovered.sections, original.sections)
    return JSON.stringify({ status: 'patched', reason: '原文事实与同一问题保持一致，仅按新配置重新提交', changes: [changes[0], { ...changes[1], expected: original.story!.timeline[0] }] })
  })
  await assert.rejects(repairSourceQuality(document, recovered, (prompt, shape) => configured(project, 'same-model', prompt, shape, signal()), () => {}, signal()),
    { code: 'structured_checkpoint_identity_mismatch' })
  assert.equal(configuredCalls, 0)
  assert.equal(sourceQualityRepairProgress(recovered), 0)
  assert.deepEqual(recovered.quality_repair_output, protectedOutput)
  assert.deepEqual(recovered.sections, original.sections)
  assert.deepEqual(recovered.story, original.story)
})
