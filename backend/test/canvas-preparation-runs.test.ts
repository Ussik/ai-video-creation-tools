import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptCanvasPlan } from '@video-studio/shared/api/contracts'

const directory = await mkdtemp(join(tmpdir(), 'canvas-runs-ledger-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, run } = await import('../src/infrastructure/database/db.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
const { canvasPreparationRuns, canvasPreparationLimits: limits } = await import('../src/modules/canvas/canvas-preparation-runs.js')
const { generationUnitStore } = await import('../src/modules/generation/generation-unit-store.js')
const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const result = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '参考准备运行隔离测试' } })
  assert.equal(result.statusCode, 200, result.body)
  const scope = { projectId: result.json().id, sceneIds: ['scene'], signature: 'a'.repeat(64), namespaces: ['visual-profiles:offline-fixture'] }
  const plan: ScriptCanvasPlan = { signature: scope.signature, scene_ids: scope.sceneIds, profiles: [], status: 'complete' }
  return { scope, plan, coordinator: canvasPreparationRuns(scope) }
}
function request() { beginTextRequest({ request_bytes: 10, estimated_input_tokens: 1, reserved_output_tokens: 1 }).complete({ input_tokens: 1, output_tokens: 1 }) }
const freshSignal = () => new AbortController().signal

test('only confirmed retryable provider failures resume a failed run; receipts and budgets stay intact', async () => {
  for (const kind of ['terminal', 'not_sent', 'rejected', 'completed', 'accepted', 'unknown', 'spoofed', 'not_retryable', 'pending'] as const) {
    const f = await fixture(), id = randomUUID()
    const issue = kind === 'spoofed' ? Object.assign(new Error('socket'), { retryable: true, responseTerminated: true })
      : Object.assign(new TextProviderError('socket', kind !== 'not_retryable', 'stream_read_error'), {
        delivery: ['not_sent', 'rejected', 'completed', 'accepted'].includes(kind) ? kind : 'output_started',
        responseTerminated: ['terminal', 'not_retryable', 'pending'].includes(kind),
      })
    await assert.rejects(f.coordinator.execute({ request_id: id }, freshSignal(), async () => {
      request()
      if (kind === 'pending') {
        const history = generationUnitStore(f.scope.projectId, f.scope.namespaces[0]!, { raw: 1 }), state = history.read()
        state.steps['response:unit:unknown'] = { input_hash: 'a', value: { input_hash: 'a', initial_started: { input_hash: 'a' } } }; history.save(state)
      }
      throw issue
    }))
    const caps = canvasPreparationRuns(f.scope).snapshot()!.preparation
    const allowed = ['terminal', 'not_sent', 'rejected', 'completed'].includes(kind)
    assert.equal(caps.can_continue, allowed, kind)
    await assert.rejects(f.coordinator.execute({ request_id: id }, freshSignal(), async () => assert.fail('original receipt cannot redispatch')))
    const resume = () => f.coordinator.execute({ run_id: caps.run_id, request_id: randomUUID() }, freshSignal(), async () => { assert.ok(allowed); request(); return f.plan })
    if (allowed) {
      const result = await resume()
      assert.equal(result.preparation!.run_id, caps.run_id)
      assert.equal(result.preparation!.budget.runs, caps.budget.runs)
      assert.equal(result.preparation!.budget.task_requests, 2)
    } else await assert.rejects(resume())
  }
})

test('identical in-flight actions join, competing actions fail and durable receipts never redispatch', async () => {
  const f = await fixture(), input = { model_id: 'fake-model', request_id: randomUUID() }
  let release!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const work = async () => { calls++; request(); await gate; return f.plan }
  const first = f.coordinator.execute(input, freshSignal(), work)
  assert.equal(f.coordinator.snapshot()!.preparation.state, 'running')
  const duplicate = canvasPreparationRuns(f.scope).execute(input, freshSignal(), work)
  await assert.rejects(f.coordinator.execute({ ...input, request_id: randomUUID() }, freshSignal(), work), { code: 'canvas_preparation_running' })
  release()
  assert.deepEqual(await first, await duplicate)
  const saved = canvasPreparationRuns(f.scope), receipt = await saved.execute(input, freshSignal(), work)
  assert.equal(receipt.preparation!.state, 'complete'); assert.equal(calls, 1)
  assert.equal(receipt.preparation!.budget.task_requests, 1)
  await assert.rejects(saved.execute({ ...input, unit_keys: ['different'] }, freshSignal(), work), { code: 'canvas_preparation_intent_conflict' })
  assert.equal(calls, 1)
})

test('new run namespaces retain original ledger and receipts and enforce the run count', async () => {
  const f = await fixture(); let calls = 0
  const work = async () => { calls++; request(); return f.plan }
  const originalInput = { request_id: randomUUID(), model_id: 'fake-model' }
  let plan = await f.coordinator.execute(originalInput, freshSignal(), work)
  for (let index = 1; index < limits.max_runs; index++) {
    const id = randomUUID()
    plan = await f.coordinator.execute({ request_id: id, restart_from_run_id: plan.preparation!.run_id, model_id: 'fake-model' }, freshSignal(), work)
    assert.equal(plan.preparation!.run_id, id); assert.equal(plan.preparation!.full_scope, true)
    assert.equal(plan.preparation!.budget.task_requests, index + 1); assert.equal(plan.preparation!.budget.run_requests, 1)
  }
  assert.equal(plan.preparation!.can_restart_all, false)
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: plan.preparation!.run_id }, freshSignal(), work), { code: 'canvas_preparation_restart_blocked' })
  const originalReceipt = await f.coordinator.execute(originalInput, freshSignal(), work)
  assert.equal(originalReceipt.preparation!.budget.task_requests, limits.max_runs)
  assert.equal(calls, limits.max_runs)
})

test('per-run requests remain bounded and a fresh run cannot reset the task-wide request budget', async () => {
  const f = await fixture(); let dispatches = 0
  const work = async () => { for (let i = 0; i <= limits.run_requests; i++) { request(); dispatches++ } return f.plan }
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), work), { code: 'text_request_budget_exceeded' })
  let caps = f.coordinator.snapshot()!.preparation
  assert.equal(dispatches, limits.run_requests); assert.equal(caps.budget.task_requests, limits.run_requests)
  assert.equal(caps.can_retry_failed, false); assert.equal(caps.can_restart_all, true)
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: caps.run_id }, freshSignal(), work), { code: 'text_request_budget_exceeded' })
  caps = f.coordinator.snapshot()!.preparation
  assert.equal(dispatches, limits.task_requests); assert.equal(caps.budget.task_requests, limits.task_requests)
  assert.equal(caps.can_restart_all, false); assert.match(caps.restart_reason, /累计预算已用尽/)
})

test('token admission rejects before charging or dispatching and preserves the existing history', async () => {
  const f = await fixture(); let dispatches = 0
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => {
    beginTextRequest({ request_bytes: 1, estimated_input_tokens: limits.run_tokens, reserved_output_tokens: 1 }); dispatches++; return f.plan
  }), { code: 'text_request_budget_exceeded' })
  assert.equal(dispatches, 0); assert.equal(f.coordinator.snapshot()!.preparation.budget.task_requests, 0)
})

test('source revisions share cumulative budgets and returning to an earlier signature cannot restore an obsolete registry', async () => {
  const f = await fixture(); let dispatches = 0
  let current = await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => { dispatches++; request(); return f.plan })
  for (const signature of ['c'.repeat(64), f.scope.signature]) {
    const revised = canvasPreparationRuns({ ...f.scope, signature })
    assert.equal(revised.snapshot()!.preparation.budget.task_requests, dispatches)
    current = await revised.execute({ request_id: randomUUID(), restart_from_run_id: current.preparation!.run_id }, freshSignal(), async () => {
      dispatches++; request(); return { ...f.plan, signature }
    })
    assert.equal(current.preparation!.budget.task_requests, dispatches)
    assert.equal(current.preparation!.budget.runs, dispatches)
  }
  assert.equal(f.coordinator.snapshot()!.preparation.can_restart_all, false)
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: current.preparation!.run_id }, freshSignal(), async () => {
    assert.fail('changing source revisions must not replenish the run count'); return f.plan
  }), { code: 'canvas_preparation_restart_blocked' })
})

test('adoption compares exact values independently of JSON object property order', async () => {
  const f = await fixture()
  const profile = { kind: 'character' as const, name: '离线人物', variant: '默认', definition: '蓝衣短发', view_requirements: '正侧背', scene_ids: f.scope.sceneIds, design_id: 'design' }
  const complete = await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => ({ ...f.plan, profiles: [profile] }))
  const { design_id, ...rest } = profile
  assert.equal(f.coordinator.assertAdoptable('legacy', { ...complete, profiles: [{ design_id, ...rest }] }), false)
  assert.throws(() => f.coordinator.assertAdoptable('legacy', { ...complete, profiles: [{ ...profile, definition: '未经确认的新外观' }] }), { code: 'canvas_preparation_adoption_blocked' })
})

test('a cancelled known request can continue; unresolved accepted responses block retry and restart', async () => {
  const f = await fixture(), controller = new AbortController(); let reject!: (error: unknown) => void
  const pending = f.coordinator.execute({ request_id: randomUUID() }, controller.signal, async () => {
    await new Promise((_, fail) => { reject = fail }); return f.plan
  })
  controller.abort(); reject(controller.signal.reason)
  await assert.rejects(pending)
  assert.equal(f.coordinator.snapshot()!.preparation.state, 'cancelled')
  assert.equal(f.coordinator.snapshot()!.preparation.can_continue, true)
  const again = new AbortController()
  const unknown = f.coordinator.execute({ request_id: randomUUID() }, again.signal, async () => {
    request()
    const history = generationUnitStore(f.scope.projectId, f.scope.namespaces[0]!, { raw: 1 }), state = history.read(), hash = 'b'.repeat(64)
    state.steps['response:unit:original'] = { input_hash: hash, value: { input_hash: hash, initial_started: { input_hash: hash } } }; history.save(state)
    await new Promise((_, fail) => { reject = fail }); return f.plan
  })
  again.abort(); reject(again.signal.reason); await assert.rejects(unknown)
  const caps = canvasPreparationRuns(f.scope).snapshot()!.preparation
  assert.equal(caps.state, 'unknown'); assert.equal(caps.can_continue, false); assert.equal(caps.can_retry_failed, false); assert.equal(caps.can_restart_all, false)
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: caps.run_id }, freshSignal(), async () => { assert.fail('unknown response must not dispatch'); return f.plan }), { code: 'canvas_preparation_unknown' })
})

test('settled orphaned claims restore complete results while source changes still require an explicit fresh run', async () => {
  const f = await fixture()
  await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => f.plan)
  const row = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT namespace,identity_hash,payload FROM model_unit_checkpoints WHERE project_id=?', f.scope.projectId)[0]!
  const checkpoint = JSON.parse(row.payload), manifest = checkpoint.steps.manifest.value
  manifest.runs[0].state = 'running'; manifest.runs[0].owner = randomUUID()
  run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(checkpoint), f.scope.projectId, row.namespace, row.identity_hash)
  for (const signature of [f.scope.signature, createHash('sha256').update('new source').digest('hex')]) {
    const restored = canvasPreparationRuns({ ...f.scope, signature })
    assert.equal(restored.snapshot()!.preparation.state, 'complete')
    if (signature === f.scope.signature) {
      const plan = await restored.execute({ request_id: randomUUID() }, freshSignal(), async () => { assert.fail('completed responses must reuse'); return f.plan })
      assert.equal(plan.preparation!.state, 'complete')
    } else {
      assert.equal(restored.snapshot()!.plan, undefined)
      await assert.rejects(restored.execute({ request_id: randomUUID() }, freshSignal(), async () => { assert.fail('source changes must not dispatch implicitly'); return f.plan }), { code: 'canvas_preparation_source_changed' })
    }
  }
})

function unresolved(f: Awaited<ReturnType<typeof fixture>>, runId = 'legacy') {
  const namespace = f.scope.namespaces[0]! + (runId === 'legacy' ? '' : ':run:' + runId)
  const history = generationUnitStore(f.scope.projectId, namespace, { incomplete: 1 }), state = history.read(), hash = 'b'.repeat(64)
  state.steps['response:unit:unresolved'] = { input_hash: hash, value: { input_hash: hash, initial_started: { input_hash: hash } } }; history.save(state)
  return all('SELECT * FROM model_unit_checkpoints WHERE project_id=? AND namespace=?', f.scope.projectId, namespace)
}

test('active cancellation fences dispatch, stays unknown for an accepted response and explicit abandonment isolates the new run idempotently', async () => {
  const f = await fixture(), input = { request_id: randomUUID(), model_id: 'fake-model' }
  let entered!: () => void; const gate = new Promise<void>(resolve => { entered = resolve })
  const first = f.coordinator.execute(input, freshSignal(), async ({ signal }) => {
    request(); unresolved(f); entered()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return f.plan
  })
  const rejected = assert.rejects(first); await gate
  const running = f.coordinator.snapshot()!.preparation
  assert.equal(running.state, 'running'); assert.equal(running.inspection!.executor, 'active'); assert.equal(running.inspection!.can_cancel, true)
  assert.ok(running.inspection!.heartbeat_at)
  assert.throws(() => f.coordinator.cancel('other-run', input.request_id), { code: 'canvas_preparation_run_changed' })
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: 'legacy', abandon_unknown: true }, freshSignal(), async () => f.plan), { code: 'canvas_preparation_running' })
  f.coordinator.cancel('legacy', input.request_id); await rejected
  const unknown = f.coordinator.snapshot()!.preparation
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.inspection!.can_cancel, false); assert.equal(unknown.inspection!.can_abandon, true)
  const preserved = all('SELECT * FROM model_unit_checkpoints WHERE project_id=? AND namespace=?', f.scope.projectId, f.scope.namespaces[0]!)
  const restart = { request_id: randomUUID(), model_id: 'fake-model', restart_from_run_id: 'legacy', abandon_unknown: true as const }
  let calls = 0
  const work = async ({ id }: { id: string }) => { calls++; assert.equal(id, restart.request_id); request(); return f.plan }
  const complete = await f.coordinator.execute(restart, freshSignal(), work)
  assert.equal(complete.preparation!.state, 'complete'); assert.equal(complete.preparation!.full_scope, true)
  assert.equal(complete.preparation!.budget.task_requests, 2)
  assert.equal(f.coordinator.assertAdoptable(restart.request_id, complete), true, 'old unknown cannot block the complete selected run')
  assert.deepEqual(all('SELECT * FROM model_unit_checkpoints WHERE project_id=? AND namespace=?', f.scope.projectId, f.scope.namespaces[0]!), preserved)
  await f.coordinator.execute(restart, freshSignal(), work); assert.equal(calls, 1)
  assert.equal(canvasPreparationRuns({ ...f.scope, sceneIds: ['other-scene'], namespaces: ['visual-profiles:other'] }).snapshot(), undefined)
  assert.equal(canvasPreparationRuns({ ...f.scope, designId: 'other-design', namespaces: ['visual-profiles:other-design'] }).snapshot(), undefined)
})

test('an unresolved retired owner stays unknown across source changes and a live foreign process is never replaced by heartbeat age', async () => {
  const f = await fixture()
  await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => f.plan)
  unresolved(f)
  const row = all<{ namespace: string; identity_hash: string; payload: string }>('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.scope.projectId).find(row => row.namespace.startsWith('canvas-preparation-runs:'))!
  const checkpoint = JSON.parse(row.payload), record = checkpoint.steps.manifest.value.runs[0]
  record.state = 'running'; record.owner = randomUUID()
  const save = () => run('UPDATE model_unit_checkpoints SET payload=? WHERE project_id=? AND namespace=? AND identity_hash=?', JSON.stringify(checkpoint), f.scope.projectId, row.namespace, row.identity_hash)
  save()
  for (const signature of [f.scope.signature, 'c'.repeat(64)]) {
    const caps = canvasPreparationRuns({ ...f.scope, signature }).snapshot()!.preparation
    assert.equal(caps.state, 'unknown'); assert.equal(caps.inspection!.can_abandon, true)
  }
  record.execution = { instance: 'another-runtime', host: (await import('node:os')).hostname(), pid: process.pid, started_at: '2000-01-01T00:00:00Z', heartbeat_at: '2000-01-01T00:00:00Z' }; save()
  const caps = f.coordinator.snapshot()!.preparation
  assert.equal(caps.state, 'running'); assert.equal(caps.inspection!.executor, 'external'); assert.equal(caps.inspection!.can_abandon, false)
  await assert.rejects(f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: 'legacy', abandon_unknown: true }, freshSignal(), async () => { assert.fail('live foreign owner must not be replaced'); return f.plan }), { code: 'canvas_preparation_unknown' })
})

test('2317 read-only recovery replaces a stale profile progress receipt with all exact completed profiles and a separate coverage stage', async () => {
  const f = await fixture()
  const profiles = Array.from({ length: 9 }, (_, i) => ({ draft_key: 'P-' + i, kind: 'prop', name: '物件' + i, variant: '默认', definition: '合法正文', view_requirements: '正侧细节', scene_ids: ['scene'], shot_usage: [] }))
  const partial = { ...f.plan, profiles: profiles.slice(0, 6) as any, status: 'partial' as const, failed_units: profiles.slice(6).map(profile => ({ unit_key: profile.draft_key,
    code: 'visual_profile_pending', message: '旧进度', retryable: false, recovery_type: 'none' as const, checkpoint_source: 'none' as const, is_new_model_call: false, attempt: 0,
    recovery: { action: 'continue' as const, model_call: 'possible' as const } })) }
  await f.coordinator.execute({ request_id: randomUUID(), model_id: 'fake-model' }, freshSignal(), async () => partial)
  const state = generationUnitStore(f.scope.projectId, f.scope.namespaces[0]!, { fixture: '2317' })
  const saved = state.read()
  saved.steps['object-catalog'] = { input_hash: 'c'.repeat(64), value: { profiles: profiles.map(({ definition, view_requirements, shot_usage, ...profile }) => profile) } }
  for (const profile of profiles) saved.steps['unit:phase:' + profile.draft_key] = { input_hash: 'd'.repeat(64), value: profile }
  saved.steps['response:visual-coverage:fixture'] = { input_hash: 'e'.repeat(64), value: { input_hash: 'e'.repeat(64), raw: '{}', correction: { input_hash: 'f'.repeat(64), raw: '{}' } } }
  state.save(saved)
  const before = all('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.scope.projectId)
  const status = canvasPreparationRuns(f.scope).snapshot()!
  assert.equal(status.plan!.profiles.length, 9)
  assert.equal(status.plan!.failed_units!.length, 1)
  assert.equal(status.plan!.failed_units![0]!.stage, 'coverage')
  assert.deepEqual(status.preparation.pending_unit_keys, ['@visual-coverage'])
  assert.equal(status.preparation.can_continue, true)
  assert.deepEqual(all('SELECT * FROM model_unit_checkpoints WHERE project_id=?', f.scope.projectId), before, 'status projection cannot edit responses or budget ledgers')
})


test('changed shot scope explains completed-run rejection while recovery reads leave all checkpoints intact', async () => {
  const f = await fixture()
  const first = await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => f.plan)
  const complete = await f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: first.preparation!.run_id }, freshSignal(), async () => ({ ...f.plan,
    profiles: [{ draft_key: 'old-prop', name: '铜锣', kind: 'prop', definition: '铜制', scene_ids: ['scene'],
      shot_usage: [{ shot_id: 'old-shot', usage: 'both', reference_view: null }] }] } as ScriptCanvasPlan))
  assert.equal(complete.preparation!.adoption!.can_adopt, true)
  const before = all('SELECT * FROM model_unit_checkpoints WHERE project_id=? ORDER BY rowid', f.scope.projectId)
  const changed = canvasPreparationRuns({ ...f.scope, signature: 'b'.repeat(64), shotIds: ['new-shot'] }).snapshot()!
  assert.equal(changed.plan, undefined)
  assert.equal(changed.preparation.adoption!.can_adopt, false)
  assert.deepEqual(changed.preparation.adoption!.missing_shot_ids, ['old-shot'])
  assert.equal(changed.preparation.adoption!.completed_profiles, 1)
  assert.match(changed.preparation.inspection!.message, /旧版镜头/)
  assert.deepEqual(all('SELECT * FROM model_unit_checkpoints WHERE project_id=? ORDER BY rowid', f.scope.projectId), before)
})


test('a changed current scope has its own bounded explicit entry after three old runs, retaining receipts and cumulative usage', async () => {
  const f = await fixture(); let calls = 0
  const work = async () => { calls++; request(); return f.plan }
  const originalInput = { request_id: randomUUID() }
  let plan = await f.coordinator.execute(originalInput, freshSignal(), work)
  for (let i = 1; i < 3; i++) plan = await f.coordinator.execute({ request_id: randomUUID(), restart_from_run_id: plan.preparation!.run_id }, freshSignal(), work)
  const before = all('SELECT * FROM model_unit_checkpoints WHERE project_id=? ORDER BY rowid', f.scope.projectId)
  const scope = { ...f.scope, signature: 'b'.repeat(64) }, next = canvasPreparationRuns(scope)
  assert.equal(next.snapshot()!.preparation.adoption!.can_prepare_current, true)
  assert.equal(next.snapshot()!.preparation.can_restart_all, false)
  assert.equal(calls, 3)
  assert.deepEqual(all('SELECT * FROM model_unit_checkpoints WHERE project_id=? ORDER BY rowid', f.scope.projectId), before)
  const action = { request_id: randomUUID(), prepare_current_from_run_id: plan.preparation!.run_id }
  const run = await next.execute(action, freshSignal(), async () => { calls++; request(); return { ...f.plan, signature: scope.signature } })
  assert.equal(run.preparation!.budget.task_requests, 4)
  assert.equal(run.preparation!.budget.runs, 4)
  assert.equal(run.preparation!.adoption!.source_updates, 1)
  assert.equal(run.preparation!.adoption!.can_adopt, true)
  await next.execute(action, freshSignal(), async () => assert.fail('duplicate current-scope intent cannot dispatch'))
  assert.equal(calls, 4)
  assert.equal(next.snapshot()!.retained_results!.length, 3)
  await next.execute(originalInput, freshSignal(), async () => assert.fail('old receipt must remain'))
  await assert.rejects(next.execute({ request_id: randomUUID(), prepare_current_from_run_id: run.preparation!.run_id }, freshSignal(), async () => assert.fail('unchanged source cannot create new range')), { code: 'canvas_preparation_current_scope_blocked' })
})

test('discard marks only stale adoption intent, preserves plan and usage and does not buy a new run', async () => {
  const f = await fixture()
  const done = await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => { request(); return f.plan })
  const current = canvasPreparationRuns({ ...f.scope, signature: 'c'.repeat(64) })
  const before = current.snapshot()!
  assert.equal(before.preparation.adoption!.can_discard, true)
  const discarded = current.discard(done.preparation!.run_id)!
  assert.deepEqual(discarded.retained_plan, before.retained_plan)
  assert.deepEqual(discarded.preparation.budget, before.preparation.budget)
  assert.equal(discarded.preparation.adoption!.discarded, true)
  assert.equal(discarded.preparation.adoption!.can_prepare_current, true)
  assert.equal(discarded.preparation.adoption!.can_discard, false)
  assert.throws(() => current.assertAdoptable(done.preparation!.run_id, f.plan), { code: 'canvas_preparation_adoption_blocked' })
  assert.equal(f.coordinator.snapshot()!.preparation.adoption!.can_adopt, false)
})

test('source updates are bounded independently and never reset the cumulative task budget', async () => {
  const f = await fixture()
  let complete = await f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => { request(); return f.plan })
  for (const char of ['b', 'c', 'd']) {
    const scope = { ...f.scope, signature: char.repeat(64) }, next = canvasPreparationRuns(scope)
    complete = await next.execute({ request_id: randomUUID(), prepare_current_from_run_id: complete.preparation!.run_id }, freshSignal(), async () => { request(); return { ...f.plan, signature: scope.signature } })
  }
  const blocked = canvasPreparationRuns({ ...f.scope, signature: 'e'.repeat(64) })
  assert.equal(blocked.snapshot()!.preparation.adoption!.can_prepare_current, false)
  assert.equal(blocked.snapshot()!.preparation.budget.task_requests, 4)
  await assert.rejects(blocked.execute({ request_id: randomUUID(), prepare_current_from_run_id: complete.preparation!.run_id }, freshSignal(), async () => assert.fail('must not dispatch')), { code: 'canvas_preparation_current_scope_blocked' })
})


test('recovery exposes persisted real steps in latest-update order without dispatching models', async () => {
  const { createModelRequestObservation } = await import('../src/modules/generation/model-request-observation.js')
  const { reportModelUnitProgress } = await import('../src/modules/generation/model-task-policy.js')
  const f = await fixture()
  const observation = createModelRequestObservation({ projectId: f.scope.projectId, owner: 'request', label: 'offline-progress' },
    { observation: () => ({ dispatch() {}, metrics() {}, finish() {} }) })
  const catalog = { phase_id: 'catalog', label: '确定对象目录', completed_units: 1, total_units: 1 }
  const profiles = { phase_id: 'profiles', label: '整理人物：林晚', completed_units: 1, total_units: 2 }
  try {
    await observation.run(() => f.coordinator.execute({ request_id: randomUUID() }, freshSignal(), async () => {
      reportModelUnitProgress(catalog); reportModelUnitProgress(profiles)
      reportModelUnitProgress({ ...catalog, label: '复用对象目录' })
      const inspection = f.coordinator.snapshot()!.preparation.inspection!
      assert.deepEqual(inspection.steps, [profiles, { ...catalog, label: '复用对象目录' }])
      assert.deepEqual(inspection.progress, { label: '复用对象目录', completed_units: 1, total_units: 1 })
      assert.equal(f.coordinator.snapshot()!.preparation.budget.run_requests, 0)
      return f.plan
    }))
  } finally { observation.finish('succeeded') }
})
