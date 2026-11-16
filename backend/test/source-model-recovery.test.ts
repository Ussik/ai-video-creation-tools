import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-source-request-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery, hasSourceModelRun } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { backgroundTextResponse } = await import('../src/infrastructure/providers/text-background.js')
initDb(); db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'source recovery', now(), now())
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const call = (generate: ReturnType<typeof sourceModelRecovery>, prompt = '当前原稿完整证据') => generate('p', 'model', prompt, undefined, new AbortController().signal)

test('completed upstream output before business checkpoint survives process reconstruction, and explicit new run permits new intentional work', async () => {
  let calls = 0
  const generate = async () => { calls++; notifyTextRequest('dispatch', { delivery: 'unknown' }); return '{"sections":["完整结果"]}' }
  const identity = { source: 'v1', model: 'm' }
  const first = sourceModelRecovery('p', 'run-complete', identity, generate)
  const output = await call(first)
  assert.equal(hasSourceModelRun('p', 'run-complete'), true)
  const reconstructed = sourceModelRecovery('p', 'run-complete', identity, generate)
  assert.equal(await call(reconstructed), output); assert.equal(calls, 1)
  await call(sourceModelRecovery('p', 'run-intent-new', identity, generate))
  assert.equal(calls, 2)
})

test('unknown ordinary dispatch cannot be automatically resent after restart or a new analysis ID', async () => {
  let posts = 0
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; throw new Error('响应在受理后丢失') }
  const identity = { source: 'unknown-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-unknown', identity, generate)), /丢失/)
  for (const id of ['run-unknown', 'run-retry-new']) {
    await assert.rejects(call(sourceModelRecovery('p', id, identity, generate)), /不能自动重新生成/)
    assert.equal(posts, 1)
  }
})

test('local preparation failure and explicitly rejected delivery do not become uncertain paid outcomes', async () => {
  let calls = 0
  const identity = { source: 'local-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-local', identity, async () => { throw new Error('尚未派发的配置错误') })), /尚未派发/)
  const recovered = sourceModelRecovery('p', 'run-local', identity, async () => { calls++; return '本地修复后完整结果' })
  assert.equal(await call(recovered), '本地修复后完整结果'); assert.equal(calls, 1)
  const rejected = { source: 'rejected-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-rejected', rejected, async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); notifyTextRequest('metrics', { delivery: 'rejected' }); throw new Error('鉴权拒绝') })), /鉴权拒绝/)
  assert.equal(await call(sourceModelRecovery('p', 'run-rejected', rejected, async () => '修复认证后的结果')), '修复认证后的结果')
})

test('accepted background response resumes by GET under the original response identity without another POST', async t => {
  let posts = 0, gets = 0, failFirstPoll = true
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { posts++; return Response.json({ id: 'resp_source_saved', status: 'in_progress' }) }
    gets++
    if (failFirstPoll) { failFirstPoll = false; throw new Error('模拟查询断线') }
    return Response.json({ id: 'resp_source_saved', status: 'completed', output_text: '已完成的原请求结果' })
  })
  const generate = async (_p: string, _m: string, prompt: string, _contract: unknown, signal: AbortSignal) => {
    const response = await backgroundTextResponse('https://fixture.invalid/responses', { model: 'same', input: prompt }, {}, signal, promise => promise, () => {})
    return JSON.stringify(await response.json())
  }
  const identity = { source: 'background-v1' }
  await assert.rejects(call(sourceModelRecovery('p', 'run-background', identity, generate)), /查询断线/)
  const result = await call(sourceModelRecovery('p', 'run-background', identity, generate))
  assert.match(result, /已完成的原请求结果/); assert.equal(posts, 1); assert.equal(gets, 2)
})

test('journal persistence failure prevents actual paid dispatch', async () => {
  let posts = 0
  const generate = sourceModelRecovery('p', 'run-persist-fail', { source: 'persist-fail' }, async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; return '不应发生' })
  db.exec("CREATE TRIGGER reject_source_dispatch BEFORE UPDATE ON source_model_requests WHEN NEW.state='dispatched' AND NEW.run_id='run-persist-fail' BEGIN SELECT RAISE(ABORT,'fixture journal failure'); END")
  try { await assert.rejects(call(generate), /journal failure/); assert.equal(posts, 0) }
  finally { db.exec('DROP TRIGGER reject_source_dispatch') }
})

test('completed output persistence failure retains dispatch barrier across a new run', async () => {
  let posts = 0
  const identity = { source: 'complete-write-fail' }
  const generate = async () => {
    notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++
    notifyTextRequest('metrics', { delivery: 'completed' })
    return '原请求已完成但本地写失败'
  }
  const first = sourceModelRecovery('p', 'run-complete-write-fail', identity, generate)
  db.exec("CREATE TRIGGER reject_source_complete BEFORE UPDATE ON source_model_requests WHEN NEW.state='completed' AND NEW.run_id='run-complete-write-fail' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END")
  try { await assert.rejects(call(first), /completion failure/) }
  finally { db.exec('DROP TRIGGER reject_source_complete') }
  await assert.rejects(call(sourceModelRecovery('p', 'run-after-write-fail', identity, generate)), /不能自动重新生成/)
  assert.equal(posts, 1)
})

test('cancellation after upstream completion retains the full result before aborting the consumer', async () => {
  const controller = new AbortController(); let posts = 0
  const identity = { source: 'cancel-after-complete' }
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; controller.abort(); return '已完成全文' }
  const first = sourceModelRecovery('p', 'run-complete-cancel', identity, generate)
  await assert.rejects(first('p', 'model', '当前原稿完整证据', undefined, controller.signal))
  const reconstructed = sourceModelRecovery('p', 'run-complete-cancel', identity, generate)
  assert.equal(await call(reconstructed), '已完成全文'); assert.equal(posts, 1)
})


const storyContract = { name: 'script_source_story', schema: { type: 'object', properties: { story: { type: 'object' } } } }
const callStory = (generate: ReturnType<typeof sourceModelRecovery>, prompt = '当前原稿完整证据', contract = storyContract) =>
  generate('p', 'model', prompt, contract, new AbortController().signal)

test('compatible continuation inherits one exact completed story reply and promotes it for process reconstruction', async () => {
  const identity = { source: 'inherit-story-v1', model: 'm', configuration: 'same' }; let calls = 0
  const generate = async () => { calls++; return `全剧整合${calls}` }
  const original = sourceModelRecovery('p', 'story-original', identity, generate)
  const output = await callStory(original)
  const resumed = sourceModelRecovery('p', 'story-resumed', identity, generate, { completedStoryRunId: 'story-original' })
  assert.equal(await callStory(resumed), output); assert.equal(calls, 1)
  const reconstructed = sourceModelRecovery('p', 'story-resumed', identity, generate)
  assert.equal(await callStory(reconstructed), output); assert.equal(calls, 1)
  assert.equal(await callStory(resumed), '全剧整合2', 'second use in the same live wrapper remains intentional new work')
  assert.equal(calls, 2)
})

test('compatible continuation also recovers the exact whole-story structural correction contract', async () => {
  const identity = { source: 'inherit-story-structure-v1' }; let calls = 0
  const generate = async () => { calls++; return '已完成结构补丁' }
  const contract = { ...storyContract, name: 'script_source_story_structure_repair' }
  await callStory(sourceModelRecovery('p', 'structure-original', identity, generate), undefined, contract)
  assert.equal(await callStory(sourceModelRecovery('p', 'structure-resumed', identity, generate, { completedStoryRunId: 'structure-original' }), undefined, contract), '已完成结构补丁')
  assert.equal(calls, 1)
})

test('new runs do not inherit stories by default, and the opt-in never inherits other contracts', async () => {
  for (const kind of ['default', 'other-contract', 'missing-contract', 'wrong-run'] as const) {
    const identity = { source: `inherit-exclusion-${kind}` }; let calls = 0
    const generate = async () => { calls++; return `结果${calls}` }
    const contract = kind === 'other-contract' ? { ...storyContract, name: 'script_source_story_characters' } : kind === 'missing-contract' ? undefined : storyContract
    const execute = (wrapped: ReturnType<typeof sourceModelRecovery>) => wrapped('p', 'model', '相同原稿', contract, new AbortController().signal)
    await execute(sourceModelRecovery('p', `exclude-${kind}-original`, identity, generate))
    const options = kind === 'default' ? undefined : { completedStoryRunId: kind === 'wrong-run' ? 'unrelated-run' : `exclude-${kind}-original` }
    assert.equal(await execute(sourceModelRecovery('p', `exclude-${kind}-resumed`, identity, generate, options)), '结果2')
    assert.equal(calls, 2)
  }
})

test('boundary completed lookup is read-only, exact, current-run only and retains unknown delivery protection', async () => {
  const identity = { source: 'boundary-peek-exact', configuration: 'same' }, contract = { name: 'script_source_map_boundary_repair', schema: { type: 'object' } }
  let posts = 0
  const generate = async () => { posts++; return '{"starts":[{"section_index":0,"start_unit":0}]}' }
  const args = ['p', 'model', 'exact boundary input', contract, new AbortController().signal] as const
  const original = sourceModelRecovery('p', 'boundary-peek-original', identity, generate)
  const response = await original(...args)
  const before = db.prepare("SELECT * FROM source_model_requests WHERE run_id='boundary-peek-original'").all()
  assert.equal(await original.readCompleted!(...args), response)
  assert.equal(await original.readCompleted!('p', 'model', args[2], { ...contract, schema: { type: 'string' } }, args[4]), undefined)
  const other = sourceModelRecovery('p', 'boundary-peek-other', identity, generate, { completedStoryRunIds: ['boundary-peek-original'] })
  assert.equal(await other.readCompleted!(...args), undefined)
  assert.deepEqual(db.prepare("SELECT * FROM source_model_requests WHERE run_id='boundary-peek-original'").all(), before)
  assert.equal(posts, 1)
  const pending = sourceModelRecovery('p', 'boundary-peek-unknown', { source: 'boundary-peek-unknown' }, async () => {
    notifyTextRequest('dispatch', { delivery: 'unknown' }); throw new Error('disconnect')
  })
  await assert.rejects(pending(...args), /disconnect/)
  await assert.rejects(pending.readCompleted!(...args), error => (error as any).code === 'source_request_unknown')
})

test('inherited story replies require the same prompt, schema, model and configuration scope', async () => {
  for (const kind of ['prompt', 'schema', 'model', 'scope'] as const) {
    const identity = { source: `inherit-exact-${kind}`, configuration: 'original' }; let calls = 0
    const generate = async () => { calls++; return `结果${calls}` }
    const originalRun = `exact-${kind}-original`
    await callStory(sourceModelRecovery('p', originalRun, identity, generate))
    const resumed = sourceModelRecovery('p', `exact-${kind}-resumed`, kind === 'scope' ? { ...identity, configuration: 'changed' } : identity, generate, { completedStoryRunId: originalRun })
    const contract = kind === 'schema' ? { ...storyContract, schema: { type: 'object', properties: { ending: { type: 'string' } } } } : storyContract
    const result = await resumed('p', kind === 'model' ? 'another-model' : 'model', kind === 'prompt' ? '已改写原稿证据' : '当前原稿完整证据', contract, new AbortController().signal)
    assert.equal(result, '结果2'); assert.equal(calls, 2)
  }
})

test('story inheritance retains unknown-dispatch barriers and blocks dispatch after failed promotion persistence', async () => {
  let posts = 0
  const identity = { source: 'inherit-unknown-story' }
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; throw new Error('上游已受理后丢失') }
  await assert.rejects(callStory(sourceModelRecovery('p', 'inherit-unknown-original', identity, generate)), /丢失/)
  await assert.rejects(callStory(sourceModelRecovery('p', 'inherit-unknown-resumed', identity, generate, { completedStoryRunId: 'inherit-unknown-original' })), /不能自动重新生成/)
  assert.equal(posts, 1)

  const completeIdentity = { source: 'inherit-promote-failure' }; let calls = 0
  const complete = async () => { calls++; return '完整候选' }
  await callStory(sourceModelRecovery('p', 'promote-original', completeIdentity, complete))
  db.exec("CREATE TRIGGER reject_story_promotion BEFORE UPDATE ON source_model_requests WHEN NEW.run_id='promote-resumed' BEGIN SELECT RAISE(ABORT,'fixture promotion failure'); END")
  try {
    await assert.rejects(callStory(sourceModelRecovery('p', 'promote-resumed', completeIdentity, complete, { completedStoryRunId: 'promote-original' })), /promotion failure/)
    assert.equal(calls, 1)
  } finally { db.exec('DROP TRIGGER reject_story_promotion') }
})


test('story continuation lineage survives queued continuations that never consume the original reply', async () => {
  const identity = { source: 'inherit-story-lineage-queue' }; let calls = 0
  const generate = async () => { calls++; return `全剧整合${calls}` }
  const originalId = 'lineage-queue-original'
  const original = await callStory(sourceModelRecovery('p', originalId, identity, generate))
  // These executions were queued then paused before reaching story synthesis.
  sourceModelRecovery('p', 'lineage-queue-paused-1', identity, generate, { completedStoryRunIds: [originalId] })
  sourceModelRecovery('p', 'lineage-queue-paused-2', identity, generate, { completedStoryRunIds: [originalId, 'lineage-queue-paused-1'] })
  const continued = sourceModelRecovery('p', 'lineage-queue-final', identity, generate, {
    completedStoryRunIds: [originalId, 'lineage-queue-paused-1', 'lineage-queue-paused-2', originalId],
  })
  assert.equal(await callStory(continued), original)
  assert.equal(calls, 1)
  assert.equal(await callStory(sourceModelRecovery('p', 'lineage-queue-final', identity, generate)), original)
  assert.equal(calls, 1)
})

test('story continuation lineage recovers a promoted reply before its business checkpoint is saved', async () => {
  const identity = { source: 'inherit-story-lineage-promoted' }; let calls = 0
  const generate = async () => { calls++; return `全剧整合${calls}` }
  const originalId = 'lineage-promoted-original', interruptedId = 'lineage-promoted-interrupted'
  const original = await callStory(sourceModelRecovery('p', originalId, identity, generate))
  assert.equal(await callStory(sourceModelRecovery('p', interruptedId, identity, generate, { completedStoryRunIds: [originalId] })), original)
  // The request row now belongs to interruptedId, but the surrounding analysis
  // has not yet persisted a complete candidate. A later compatible execution
  // must allow both the original and the interrupted ancestor identities.
  const reconstructed = sourceModelRecovery('p', 'lineage-promoted-final', identity, generate, {
    completedStoryRunIds: [originalId, interruptedId, interruptedId],
  })
  assert.equal(await callStory(reconstructed), original)
  assert.equal(calls, 1)
  assert.equal(await callStory(sourceModelRecovery('p', 'lineage-promoted-final', identity, generate)), original)
  assert.equal(calls, 1)
})


test('resume eligibility correlates the exact background identity and never mutates unknown dispatches', async () => {
  const { sourceModelRecoveryBlocked } = await import('../src/modules/script/source-model-recovery.js')
  const runId = 'blocked-helper-background'
  sourceModelRecovery('p', runId, { source: 'blocked-helper-background' }, async () => 'unused')
  db.prepare('INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('p', 'helper-scope', 'helper-request', runId, 'dispatched', 'unknown', null, 'exact-response', now())
  db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)')
    .run('p', 'helper-scope', 'unrelated-response', JSON.stringify({ state: 'accepted', id: 'resp_unrelated' }))
  assert.equal(sourceModelRecoveryBlocked('p', [runId]), true)
  db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)')
    .run('p', 'helper-scope', 'exact-response', JSON.stringify({ state: 'accepted', id: 'resp_exact' }))
  assert.equal(sourceModelRecoveryBlocked('p', [runId]), false)
  assert.equal((db.prepare('SELECT state FROM source_model_requests WHERE request_key=?').get('helper-request') as { state: string }).state, 'dispatched')
})

test('part recovery reader inherits only exact complete responses in the permitted lineage without promotion or provider dispatch', async () => {
  const identity = { source: 'part-peek-v1', model: 'm', configuration: 'same' }
  let posts = 0
  const generate = async () => { posts++; return 'complete original part' }
  const contract = { ...storyContract, name: 'script_source_story_characters' }
  const original = sourceModelRecovery('p', 'part-peek-original', identity, generate)
  const args = ['p', 'model', 'exact historical part prompt', contract, new AbortController().signal] as const
  await original(...args)
  const inherited = sourceModelRecovery('p', 'part-peek-resumed', identity, generate, { completedStoryRunIds: ['part-peek-original'] })
  const before = db.prepare("SELECT run_id,updated_at FROM source_model_requests WHERE project_id='p' AND run_id='part-peek-original'").get()
  assert.equal(await inherited.readCompleted!(...args), 'complete original part')
  assert.equal(posts, 1)
  assert.deepEqual(db.prepare("SELECT run_id,updated_at FROM source_model_requests WHERE project_id='p' AND run_id='part-peek-original'").get(), before)
  const excluded = sourceModelRecovery('p', 'part-peek-unrelated', identity, generate, { completedStoryRunIds: ['wrong'] })
  assert.equal(await excluded.readCompleted!(...args), undefined)
  assert.equal(await inherited.readCompleted!('p', 'changed-model', args[2], contract, args[4]), undefined)
  assert.equal(await inherited.readCompleted!('p', 'model', 'changed prompt', contract, args[4]), undefined)
  assert.equal(await inherited.readCompleted!('p', 'model', args[2], { ...contract, schema: { type: 'string' } }, args[4]), undefined)
  const changedScope = sourceModelRecovery('p', 'part-peek-other-scope', { ...identity, configuration: 'changed' }, generate, { completedStoryRunIds: ['part-peek-original'] })
  assert.equal(await changedScope.readCompleted!(...args), undefined)
  assert.equal(posts, 1)
})

test('part recovery reader preserves exact unknown-dispatch barriers and misses incomplete or foreign-contract rows', async () => {
  const identity = { source: 'part-peek-unknown-v1' }; let posts = 0
  const contract = { ...storyContract, name: 'script_source_story_timeline' }
  const generate = async () => { notifyTextRequest('dispatch', { delivery: 'unknown' }); posts++; throw new Error('accepted response lost') }
  const args = ['p', 'model', 'unknown historical part prompt', contract, new AbortController().signal] as const
  await assert.rejects(sourceModelRecovery('p', 'part-peek-unknown', identity, generate)(...args), /lost/)
  const resumed = sourceModelRecovery('p', 'part-peek-unknown-next', identity, generate, { completedStoryRunIds: ['part-peek-unknown'] })
  await assert.rejects(resumed.readCompleted!(...args), (issue: unknown) => (issue as { code: string }).code === 'source_request_unknown')
  assert.equal(posts, 1)
  assert.equal(await resumed.readCompleted!('p', 'model', args[2], { ...contract, name: 'script_source_map' }, args[4]), undefined)
  db.prepare("UPDATE source_model_requests SET state='failed' WHERE project_id='p' AND run_id='part-peek-unknown'").run()
  assert.equal(await resumed.readCompleted!(...args), undefined)
  assert.equal(posts, 1)
})

test('a pending sibling permit leaves exact completed part replay readonly and blocks only new dispatch', async () => {
  const id = 'sibling-permit-project', stamp = now(), oldRun = 'sibling-original', newRun = 'sibling-resumed'
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  const identity = { source: 'same-source', model: 'model', configuration: 'same' }
  const contract = { name: 'script_source_story_uncertainties', schema: { type: 'object' } }
  const args = (prompt: string) => [id, 'model', prompt, contract, new AbortController().signal] as const
  const old = sourceModelRecovery(id, oldRun, identity, async () => 'complete sibling response')
  await old(...args('completed sibling'))
  const row = db.prepare('SELECT scope FROM source_model_requests WHERE project_id=?').get(id) as { scope: string }
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES ('sibling-action',?,'sibling-client','digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id,newRun,stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES ('sibling-epoch','sibling-action',?,?,'unknown-sibling-key',?,'prepared','not_sent',?)`).run(id,row.scope,newRun,stamp)
  const epoch = () => db.prepare("SELECT * FROM source_request_recovery_epochs WHERE id='sibling-epoch'").get()
  const before = epoch(), requests = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(id)
  let calls = 0
  const resumed = sourceModelRecovery(id, newRun, identity, async () => { calls++; return 'new purchase forbidden' }, { completedStoryRunIds: [oldRun] })
  assert.equal(await resumed.readCompleted!(...args('completed sibling')), 'complete sibling response')
  assert.equal(await resumed(...args('completed sibling')), 'complete sibling response')
  await assert.rejects(resumed(...args('another prompt')), error => {
    assert.equal((error as any).code, 'source_request_sibling_pending'); assert.equal((error as any).delivery, 'not_sent'); return true
  })
  assert.equal(calls, 0); assert.deepEqual(epoch(), before)
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(id), requests)
  assert.equal((db.prepare("SELECT count(*) AS n FROM source_request_recovery_resolutions WHERE project_id=?").get(id) as {n:number}).n,0)
})

test('completed-only sibling replay requires exact scope, model, schema and run lineage despite another pending epoch', async () => {
  const identity = { source: 'sibling-read-scope', configuration: 'same' }, name = 'script_source_story_uncertainties'
  const contract = { name, schema: { type: 'object' } }, signal = new AbortController().signal
  const original = sourceModelRecovery('p', 'sibling-read-original', identity, async () => 'saved exact response')
  await original('p','model','original prompt',contract,signal)
  const resumed = sourceModelRecovery('p','sibling-read-resumed',identity,async()=>assert.fail('must be readonly'),{completedStoryRunIds:['sibling-read-original']})
  assert.equal(await resumed.readCompleted!('p','model','original prompt',contract,signal),'saved exact response')
  for (const [model,prompt,c] of [['changed','original prompt',contract],['model','changed',contract],['model','original prompt',{name,schema:{type:'string'}}]] as const)
    assert.equal(await resumed.readCompleted!('p',model,prompt,c,signal),undefined)
  const wrongScope = sourceModelRecovery('p','sibling-read-scope',{...identity,configuration:'changed'},async()=>assert.fail('must not dispatch'),{completedStoryRunIds:['sibling-read-original']})
  assert.equal(await wrongScope.readCompleted!('p','model','original prompt',contract,signal),undefined)
})

test('a sibling permit blocks new ordinary epochs after completed, settled or failed work without mutating either allowance', async t => {
  for (const state of ['completed', 'settled', 'failed'] as const) await t.test(state, async () => {
    const id = 'sibling-terminal-' + state, oldRun = id + '-old', newRun = id + '-new', stamp = now()
    db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
    const identity = { source: id, model: 'model' }, contract = { name: 'script_source_story_uncertainties', schema: { type: 'object' } }
    const args = [id, 'model', 'exact prior task', contract, new AbortController().signal] as const
    await sourceModelRecovery(id, oldRun, identity, async () => 'completed exact sibling')(...args)
    const original = db.prepare('SELECT scope,request_key FROM source_model_requests WHERE project_id=?').get(id) as { scope: string; request_key: string }
    const action = id + '-action'
    db.prepare(`INSERT INTO source_request_recovery_actions
      (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
      VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(action, id, id + '-client', newRun, stamp)
    db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,result,consumed_at,local_request_id,updated_at)
      VALUES (?,?,?,?,?,?,?,'completed',?,?,?,?)`).run(id + '-terminal', action, id, original.scope, original.request_key, oldRun,
        state, state === 'completed' ? 'completed exact sibling' : null, stamp, id + '-dispatch', stamp)
    db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
      VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-pending', action, id, original.scope, 'different-pending-request', newRun, stamp)
    const snapshot = () => ({
      epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=? ORDER BY sequence').all(id),
      requests: db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(id),
      resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id),
    })
    let calls = 0
    const resumed = sourceModelRecovery(id, newRun, identity, async () => { calls++; assert.fail('cannot purchase another request') }, { completedStoryRunIds: [oldRun] })
    const before = snapshot()
    assert.equal(await resumed.readCompleted!(...args), state === 'completed' ? 'completed exact sibling' : undefined)
    if (state === 'completed') assert.equal(await resumed(...args), 'completed exact sibling')
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(resumed(...args), error => (error as { code?: string }).code === 'source_request_sibling_pending')
      assert.deepEqual(snapshot(), before, 'blocking must precede creation or consumption of any new epoch')
    }
    assert.equal(calls, 0)
  })
})


test('explicit map continuation reuses exact completed pages but never crosses prompt schema model or source identity', async () => {
  for (const name of ['script_source_map', 'script_source_map_page']) {
    for (const change of ['none', 'prompt', 'schema', 'model', 'scope']) {
      const identity = { source: `map-reuse-${name}-${change}`, configuration: 'original' }
      const contract = { name, schema: { type: 'object', properties: { sections: { type: 'array' } } } }
      let calls = 0
      const generate = async () => { calls++; return `complete-page-${calls}` }
      const original = `map-${name}-${change}-original`
      await sourceModelRecovery('p', original, identity, generate)('p', 'model', 'exact full source and window', contract, new AbortController().signal)
      const resumed = sourceModelRecovery('p', `map-${name}-${change}-resumed`, change === 'scope' ? { ...identity, source: 'changed' } : identity,
        generate, { completedStoryRunIds: [original] })
      const result = await resumed('p', change === 'model' ? 'different' : 'model', change === 'prompt' ? 'changed window' : 'exact full source and window',
        change === 'schema' ? { ...contract, schema: { type: 'string' } } : contract, new AbortController().signal)
      assert.equal(calls, change === 'none' ? 1 : 2)
      assert.equal(result, change === 'none' ? 'complete-page-1' : 'complete-page-2')
    }
  }
})

test('map syntax correction binds separate ledger prompts, responses and checkpoints without full-page redispatch', async () => {
  const { createHash } = await import('node:crypto')
  const { generateSourceMapOutput } = await import('../src/modules/script/script-source-map-output.js')
  const { scriptSourcePassages, resolveSourceSections } = await import('../src/modules/script/script-source-map.js')
  const source = '# 第1集\n计划回家，但尚未执行。'
  const value = { sections: [{ start_unit: 0, title: '第1集', episode_number: 1, summary: '计划"回家",但尚未执行。', characters: [], events: [], open_threads: [] }] }
  const malformed = JSON.stringify(value, null, 2).replace('计划\\"回家\\"', '计划"回家"')
  const cp: import('../src/modules/generation/model-output.js').StructuredOutputCheckpoint = {}
  let calls = 0; const prompts: string[] = []
  const recovery = sourceModelRecovery('p', 'run-syntax-ledger', { source: 'syntax-ledger-v1', model: 'model' }, async (_p, _m, prompt, contract) => {
    prompts.push(prompt); notifyTextRequest('dispatch', { delivery: 'unknown' }); calls++
    if (calls === 1) { assert.equal(contract!.name, 'script_source_map'); return malformed }
    assert.equal(contract!.name, 'script_source_map_local_repair')
    assert.ok(!prompt.includes('【原始任务与资料】'))
    const line = JSON.stringify(value, null, 2).split('\n').find(line => line.includes('\"summary\"'))!
    return JSON.stringify({ candidate_hash: createHash('sha256').update(malformed).digest('hex'), repairs: { line_0: { line, reason: '逗号属于正文，保持全部原字面内容，只补转义' } } })
  })
  const result = await generateSourceMapOutput('private original input', scriptSourcePassages(source),
    (prompt, contract) => recovery('p', 'model', prompt, contract, new AbortController().signal),
    { signal: new AbortController().signal, checkpoint: cp, persist() {} })
  assert.equal(calls, 2); assert.notEqual(prompts[0], prompts[1]); assert.equal(cp.original_raw, malformed)
  const rows = db.prepare('SELECT request_key,result FROM source_model_requests WHERE project_id=? AND run_id=?').all('p', 'run-syntax-ledger') as Array<{ request_key: string; result: string }>
  assert.equal(rows.length, 2); assert.notEqual(rows[0]!.request_key, rows[1]!.request_key); assert.notEqual(rows[0]!.result, rows[1]!.result)
  assert.deepEqual(resolveSourceSections(result, scriptSourcePassages(source)).problems, [])
  await generateSourceMapOutput('private original input', scriptSourcePassages(source), async () => assert.fail('complete candidate never redispatches'),
    { signal: new AbortController().signal, checkpoint: cp, persist() {} })
  assert.equal(calls, 2)
})

test('whole-story and local-patch completed readers preserve exact inherited ledger rows without dispatch or promotion', async () => {
  for (const name of ['script_source_story', 'script_source_story_local_repair', 'script_source_story_threads_local_repair']) {
    const identity = { source: 'read-only-complete-' + name, model: 'model' }, original = 'old-' + name
    const contract = { name, schema: { type: 'object' } }, signal = new AbortController().signal
    let calls = 0
    const generate = async () => { calls++; notifyTextRequest('dispatch', { delivery: 'unknown' }); return '{"complete":"saved"}' }
    await sourceModelRecovery('p', original, identity, generate)('p', 'model', 'exact frozen prompt', contract, signal)
    const before = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND run_id=?').all('p', original)
    const resumed = sourceModelRecovery('p', 'new-' + name, identity, async () => assert.fail('completed reader is read-only'), { completedStoryRunIds: [original] })
    assert.equal(await resumed.readCompleted!('p', 'model', 'exact frozen prompt', contract, signal), '{"complete":"saved"}')
    assert.equal(await resumed.readCompleted!('p', 'model', 'changed prompt', contract, signal), undefined)
    assert.equal(await resumed.readCompleted!('p', 'other', 'exact frozen prompt', contract, signal), undefined)
    assert.equal(calls, 1)
    assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND run_id=?').all('p', original), before)
  }
})
