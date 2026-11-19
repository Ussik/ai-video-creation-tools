import assert from 'node:assert/strict'
import { evidenceWireValue } from './helpers/appearance-evidence.js'
import { appearanceEvidence } from '../src/modules/visuals/visual-appearance-evidence.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { appearanceArbitration } from '../src/modules/visuals/visual-appearance-arbitration.js'
import { visualCoverageUnit } from '../src/modules/visuals/visual-coverage-unit.js'
import { coverageRecoveryPolicy, coverageRecoveryState, coverageRecoveryToken } from '../src/modules/visuals/visual-coverage-recovery.js'
import { TextInputScopeError } from '../src/infrastructure/providers/text-input-scope.js'
import { visualRetryToken } from '../src/modules/visuals/visual-profile-retry.js'
import { createGenerationSteps } from '../src/modules/script/script-generation-steps.js'
import { outputContract } from '../src/modules/generation/model-output.js'
const incident = JSON.parse(await readFile(new URL('./fixtures/visual-coverage-0004.json', import.meta.url), 'utf8'))
const source = JSON.parse(await readFile(new URL('./fixtures/visual-coverage-2317.json', import.meta.url), 'utf8'))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keys = ['PROP-CHAOFENDAI', 'PROP-CHAOFENDAI-VARIANT']
export function legacyFixture(index = 0) {
  const shot = source.shots[index], profiles = source.profiles.filter((p: any) => keys.includes(p.draft_key))
  const plan = appearanceArbitration(shot, source.scenes[0], profiles)
  const prompt = (plan as any).legacyPrompt || plan.prompt
  const contract = outputContract('visual_reference_coverage', plan.schema)
  const identity = { policy: 'visual-coverage-unit-v1', prompt, schema: contract.schema }, key = '@appearance:' + shot.id
  const stepId = 'unit:' + hash(identity) + ':' + key, originalInput = { identity, key }
  let state: any = { steps: {} }, slot = '', response: any
  let args: any = originalInput, id = stepId, token = ''
  const initialHash = hash(['visual_reference_coverage', contract.schema, prompt])
  for (let n = 0; n < 4; n++) {
    const binding = hash({ parent_input_hash: hash(args), name: contract.name, prompt, schema: contract.schema })
    slot = 'response:' + id + ':' + binding
    response = { input_hash: initialHash, raw: incident.original_shapes[index], original_raw: incident.original_shapes[index] }
    state.steps[slot] = { input_hash: binding, value: response }
    if (n) state.steps['retry-failed:' + stepId + ':' + token] = { input_hash: hash(args), value: { code: 'model_business_validation', delivery: 'completed' } }
    token = n ? visualRetryToken(stepId, slot, response, n + 1) : hash({ policy: 'coverage-retry-v1', stepId, original: response })
    id = 'retry:' + stepId + ':' + token; args = { original: originalInput, retry_token: token }
  }
  return { state, plan, shot, profiles, stepId, key }
}
test('00:04 four local validations preserve a recoverable real allowance instead of falsely reaching 4/4', async () => {
  const f = legacyFixture(); let calls = 0
  const result = await visualCoverageUnit({ ...f.plan, key: f.key, name: '离线镜头', sceneIds: ['scene'], shotIds: [f.shot.id],
    steps: createGenerationSteps({ checkpoint: f.state }), generate: async () => { calls++; throw new Error('must not dispatch while reopening') } })
  assert.ok('failure' in result)
  assert.equal(calls, 0)
  assert.equal(result.failure.recovery?.action, 'retry', JSON.stringify(result.failure))
  assert.equal(result.failure.attempt, 1)
})
function finalDecision(f: ReturnType<typeof legacyFixture>) {
  const quote = (field: string) => { const proof = appearanceEvidence(f.shot).candidates.find(item => item.field === field)!; return {field,quote:proof.quote} }
  return { decisions: Object.fromEntries(keys.map((key, index) => [key, {
    relation_to_base: index ? 'replacement' : 'independent',
    image: { visible: !index, evidence: quote('image_prompt') },
    video: { visible: !index, phase: index ? 'not_visible' : 'throughout', evidence: quote('video_prompt') },
    reason: index ? '本镜证据为手持袋子，尚未发生装入口袋动作，派生状态不出镜。' : '本镜首帧和视频过程均保持手持袋子，属于基础状态。',
  }])) }
}
function patchFor(contract: any, final: any) {
  return { repairs: Object.fromEntries(Object.keys(contract.schema.properties.repairs.properties).map(key => {
    const path = key.split('__')
    return [key, path.reduce((value: any, part) => value[part], final.decisions)]
  })) }
}
test('00:04 actual array shapes recover through one missing-field request each, retain all original bytes and replay idempotently', async () => {
  for (const index of [0, 1]) {
    const f = legacyFixture(index), original = structuredClone(f.state)
    let checkpoint = f.state, calls = 0
    const execute = (token?: string) => visualCoverageUnit({ ...f.plan, key: f.key, name: '离线镜头', sceneIds: [source.scenes[0].id], shotIds: [f.shot.id], retryToken: token,
      steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
      generate: async (prompt, contract) => {
        calls++
        assert.equal(contract?.name, 'visual_reference_coverage_local_repair')
        const fields = Object.keys((contract!.schema as any).properties.repairs.properties)
        assert.ok(fields.includes(keys[0] + '__image__evidence'))
        assert.ok(!fields.some(field => /__visible|__phase|__image$|__video$/.test(field)), 'valid visibility/phase frozen')
        assert.ok(prompt.includes('本次镜头证据：'))
        assert.ok(prompt.includes('ref_id') && prompt.includes('来源版本：'))
        return JSON.stringify(evidenceWireValue(f.shot, patchFor(contract, finalDecision(f))))
      } })
    const pending = await execute()
    assert.ok('failure' in pending)
    assert.equal(pending.failure.attempt, 1)
    assert.equal(pending.failure.local_validation_count, 4)
    assert.equal(calls, 0)
    const done = await execute(pending.failure.recovery!.token)
    assert.ok('value' in done, JSON.stringify(done))
    assert.deepEqual(done.value, finalDecision(f))
    assert.equal(calls, 1)
    const again = await execute(pending.failure.recovery!.token)
    assert.ok('value' in again)
    assert.equal(calls, 1)
    for (const [key, entry] of Object.entries(original.steps)) assert.deepEqual(checkpoint.steps[key], entry, 'legacy audit immutable: ' + key)
    const audit = Object.entries(checkpoint.steps).filter(([key]) => key.startsWith('coverage-attempt-v2:')).map(([, entry]: any) => entry.value)
    assert.equal(audit.length, 1); assert.equal(audit[0].model_request_count, 1)
    assert.equal(audit[0].state, 'complete')
    assert.ok(Object.keys(checkpoint.steps).some(key => key.startsWith('coverage-migration-v2:')))
  }
})
test('array normalization preserves fields but rejects ambiguous identities; evidence prose is never converted into quotes', () => {
  const f = legacyFixture(), raw = JSON.parse(incident.original_shapes[0].replace(/^```json\s*|\s*```$/g, ''))
  const normalized: any = f.plan.normalize(raw)
  assert.deepEqual(normalized.decisions[keys[0]].image, raw.decisions[0].image)
  assert.equal(normalized.decisions[keys[0]].relation_to_base, undefined)
  assert.equal(normalized.decisions[keys[0]].reason, undefined)
  assert.throws(() => f.plan.validate(normalized))
  for (const change of [
    (v: any) => { v.decisions[1].draft_key = keys[0] },
    (v: any) => { v.decisions[1].draft_key = 'wrong-key' },
    (v: any) => { v.decisions[0].object_key = keys[0] },
    (v: any) => { v.decisions.pop() },
  ]) {
    const value = structuredClone(raw); change(value)
    assert.deepEqual(f.plan.normalize(value), value)
    assert.equal(f.plan.planLocalRepair(value, { issues: f.plan.schema.safeParse(value).error!.issues }), undefined)
  }
  const extra = structuredClone(normalized); extra.decisions[keys[0]].unowned = 'never drop me'
  assert.equal(f.plan.planLocalRepair(extra, { issues: f.plan.schema.safeParse(extra).error!.issues }), undefined)
})
test('safe missing parent is corrected with exact schema while conflicting fields and fabricated quotes remain rejected', () => {
  const f = legacyFixture(), missing = { decisions: { [keys[0]]: finalDecision(f).decisions[keys[0]] } }
  const plan = f.plan.planLocalRepair(missing, { issues: f.plan.schema.safeParse(missing).error!.issues })!
  assert.ok(plan)
  assert.deepEqual(plan.apply(evidenceWireValue(f.shot, { repairs: { [keys[1]]: finalDecision(f).decisions[keys[1]] } })), finalDecision(f))
  const bad = finalDecision(f)
  bad.decisions[keys[0]].image.evidence.quote = 'fabricated quote never appears in source'
  assert.throws(() => f.plan.validate(bad), /逐字/)
  const conflict = finalDecision(f)
  conflict.decisions[keys[1]].image.visible = true
  assert.throws(() => f.plan.validate(conflict), /同时在首帧/)
  conflict.decisions[keys[1]].image.visible = false
  conflict.decisions[keys[1]].video = { visible: true, phase: 'throughout', evidence: { field: 'video_prompt', quote: f.shot.video_prompt.slice(0,100) } }
  assert.throws(() => f.plan.validate(conflict), /前后变化阶段/)
})
test('unknown request remains fenced; genuine invalid patch requests consume real allowance and eventually stop at four', async () => {
  for (const unknown of [false, true]) {
    const f = legacyFixture(); let checkpoint = f.state, calls = 0
    const execute = (token?: string) => visualCoverageUnit({ ...f.plan, key: f.key, name: '离线镜头', sceneIds: ['scene'], shotIds: [f.shot.id], retryToken: token,
      steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
      generate: async () => { calls++; if (unknown) throw new TypeError('connection interrupted after dispatch'); return JSON.stringify({ repairs: {} }) } })
    let result = await execute(); assert.ok('failure' in result)
    const token = result.failure.recovery!.token!
    result = await execute(token); assert.ok('failure' in result)
    assert.equal(calls, 1)
    const after = calls
    await execute(token); await execute()
    assert.equal(calls, after)
    if (unknown) {
      assert.equal(result.failure.recovery?.action, 'inspect')
      assert.equal(result.failure.recovery?.model_call, 'unknown')
    } else {
      for (let count = 2; count < 4; count++) {
        assert.equal(result.failure.model_request_count, count)
        assert.equal(result.failure.recovery?.action, 'retry')
        result = await execute(result.failure.recovery!.token); assert.ok('failure' in result)
      }
      assert.equal(result.failure.model_request_count, 4)
      assert.equal(result.failure.recovery?.action, 'none')
      assert.equal(calls, 3, 'original real response + three actual patches, not the four local validations')
    }
  }
})


test('legacy migration refuses reordered, missing, ambiguous or unresolved history and retains real correction use', () => {
  const f = legacyFixture()
  assert.equal(coverageRecoveryState(f.state, f.stepId).model_request_count, 1)
  assert.equal(coverageRecoveryState({ steps: Object.fromEntries(Object.entries(f.state.steps).reverse()) }, f.stepId).blocked, true)
  for (const mutate of [
    (state: any) => { delete state.steps[Object.keys(state.steps).find(key => key.startsWith('response:retry:'))!] },
    (state: any) => { const [key, entry] = Object.entries(state.steps).find(([key]) => key.startsWith('response:unit:'))!; state.steps[key + ':ambiguous'] = entry },
    (state: any) => { const entry: any = Object.values(state.steps)[0]; entry.value.correction_started = { input_hash: 'f'.repeat(64) } },
  ]) {
    const state = structuredClone(f.state); mutate(state)
    assert.equal(coverageRecoveryState(state, f.stepId).blocked, true)
  }
  const state = structuredClone(f.state)
  const entry: any = Object.entries(state.steps).find(([key]) => key.startsWith('response:retry:'))![1]
  entry.value.correction = { input_hash: 'f'.repeat(64), raw: 'complete actual patch' }
  const result = coverageRecoveryState(state, f.stepId)
  // Adding/changing a paid response invalidates the downstream token chain;
  // it must never create another allowance by treating equal raw as proof.
  assert.equal(result.blocked, true)
  assert.ok(result.model_request_count >= 2)
})
test('only trusted pre-dispatch denial is excluded from request counts, arbitrary not_sent cannot clear uncertainty', async () => {
  for (const trusted of [false, true]) {
    const f = legacyFixture(); let checkpoint = f.state
    const execute = (token?: string) => visualCoverageUnit({ ...f.plan, key: f.key, name: '离线镜头', sceneIds: ['scene'], shotIds: [f.shot.id], retryToken: token,
      steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
      generate: async () => { throw trusted ? new TextInputScopeError('visual_input_assembly_missing', 'assembly') : Object.assign(new Error('untrusted'), { delivery: 'not_sent' }) } })
    const first = await execute(); assert.ok('failure' in first)
    const result = await execute(first.failure.recovery!.token); assert.ok('failure' in result)
    assert.equal(result.failure.model_request_count, trusted ? 1 : 2)
    assert.equal(result.failure.is_new_model_call, !trusted)
    assert.equal(result.failure.recovery?.action, 'inspect')
  }
})

test('a provider-terminal correction can retry the same coverage unit while ordinary unknown delivery stays fenced', async () => {
  const f = legacyFixture(), raw = incident.original_shapes[0]
  let checkpoint: any = { steps: {} }, calls = 0
  const responseHash = 'a'.repeat(64), responseSlot = `response:${f.stepId}:${responseHash}`
  checkpoint.steps[responseSlot] = { input_hash: responseHash, value: {
    input_hash: responseHash, raw, original_raw: raw,
    correction_started: { input_hash: 'b'.repeat(64) },
  } }
  const execute = (retryToken?: string, trustedTerminalTransport = false) => visualCoverageUnit({ ...f.plan,
    key: f.key, name: '锁链无声用途仲裁', sceneIds: ['scene'], shotIds: [f.shot.id], retryToken, trustedTerminalTransport,
    steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    generate: async (_prompt, contract) => {
      calls++
      assert.equal(contract?.name, 'visual_reference_coverage_local_repair')
      return JSON.stringify(evidenceWireValue(f.shot, patchFor(contract, finalDecision(f))))
    },
  })
  const blocked = await execute()
  assert.ok('failure' in blocked)
  assert.equal(blocked.failure.recovery?.model_call, 'unknown')
  assert.equal(calls, 0)

  const trustedCheckpoint = structuredClone(checkpoint)
  const response = trustedCheckpoint.steps[responseSlot].value
  delete response.correction_started
  const recovered = coverageRecoveryState(trustedCheckpoint, f.stepId)
  assert.equal(recovered.blocked, false)
  const schema = outputContract('visual_reference_coverage', f.plan.schema).schema
  const contextHash = hash({ policy: coverageRecoveryPolicy, stepId: f.stepId, prompt: f.plan.requestPrompt || f.plan.prompt, schema })
  const token = coverageRecoveryToken(f.stepId, recovered.parent_hash, contextHash)
  const retried = await execute(token, true)
  assert.ok('value' in retried, JSON.stringify(retried))
  assert.equal(calls, 1)
  assert.equal(checkpoint.steps[responseSlot].value.correction_started.input_hash, 'b'.repeat(64), 'original private response stays immutable')
})
