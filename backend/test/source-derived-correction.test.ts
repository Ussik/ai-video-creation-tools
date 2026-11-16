import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import { generateStructuredOutput, initialStructuredOutputRequest } from '../src/modules/generation/model-output.js'
import { withInitialSourceStoryRequest, withDerivedSourceCorrectionRequest, currentDerivedSourceCorrectionRequest,
  sourceDispatchRequestKey, type DerivedSourceCorrectionRequest } from '../src/modules/script/source-story-dispatch-identity.js'
import { reviewSourceQuality } from '../src/modules/script/script-source-quality.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-derived-correction-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { synthesizeSourceStoryParts, sourceStorySchema } = await import('../src/modules/script/script-source-story-parts.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const signal = () => new AbortController().signal
const contract = { name: 'script_source_story_characters_merge', schema: { type: 'object' } }
const initialPrompt = 'ordinary initial merge', raw = '{"characters":[{"name":"钟匠"}]}'
const correctionPrompt = 'one exact frozen correction'
let sequence = 0
async function fixture() {
  const id = 'derived-correction-' + sequence++, oldRun = id + '-old', runId = id + '-ordinary', stamp = now()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  const identity = { source: id + '-source', model: 'model', configuration: 'same' }
  const old = sourceModelRecovery(id, oldRun, identity, async () => {
    notifyTextRequest('dispatch', { request_id: id + '-old', delivery: 'unknown' }); throw new Error('old unknown')
  })
  await assert.rejects(old(id, 'model', 'old correction', { ...contract, name: 'script_source_story_uncertainties' }, signal()), /old unknown/)
  const oldRow = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(id) as any
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', runId, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, oldRow.scope, oldRow.request_key, runId, stamp)
  const initial = sourceModelRecovery(id, runId, identity, async () => {
    notifyTextRequest('dispatch', { request_id: id + '-initial', delivery: 'unknown' }); return raw
  }, { completedStoryRunIds: [oldRun], ordinaryStoryDispatch: () => true })
  await withInitialSourceStoryRequest({ task_key: 'characters_merge:new', candidate_hash: 'a'.repeat(64) }, 'model', initialPrompt, contract,
    () => initial(id, 'model', initialPrompt, contract, signal()))
  const proof = { task_key: 'characters_merge:new', candidate_hash: 'a'.repeat(64), base_input_hash: hash('initial base'),
    initial_request_key: sourceDispatchRequestKey('model', initialPrompt, contract), initial_response_hash: hash(raw),
    correction_input_hash: hash(JSON.stringify([correctionPrompt, contract])) }
  const preserved = () => ({
    old: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, oldRow.request_key),
    initial: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, proof.initial_request_key),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id),
  })
  return { id, oldRun, runId, identity, oldRow, proof, preserved }
}
function proven(f: Awaited<ReturnType<typeof fixture>>, work: () => Promise<string>, proof = f.proof, prompt = correctionPrompt, actual = contract) {
  return withModelRequestContext({ policy: modelTaskPolicies.generation, operationStage: 'format_correction' }, () =>
    withDerivedSourceCorrectionRequest(proof, 'model', prompt, actual, work))
}

test('one frozen derived correction uses its own ordinary grant and preserves its initial response and sibling permit', async () => {
  const f = await fixture(), before = f.preserved(); let posts = 0, checks = 0
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
    notifyTextRequest('dispatch', { request_id: f.id + '-correction', delivery: 'unknown' }); posts++; return 'fixed response'
  }, { completedStoryRunIds: [f.oldRun], ordinaryCorrectionDispatch: (proof, initialRunId) => {
    checks++; assert.equal(initialRunId, f.runId); assert.deepEqual(proof, { ...f.proof, request_key: sourceDispatchRequestKey('model', correctionPrompt, contract) }); return true
  } })
  assert.equal(await proven(f, () => wrapped(f.id, 'model', correctionPrompt, contract, signal())), 'fixed response')
  assert.equal(posts, 1); assert.ok(checks >= 2); assert.deepEqual(f.preserved(), before)
})

test('an inherited ordinary initial is identified by its actual run, never by a sibling recovery epoch', async () => {
  const f = await fixture(), before = f.preserved(), nextRun = f.id + '-continued'; let posts = 0
  const wrapped = sourceModelRecovery(f.id, nextRun, f.identity, async () => {
    notifyTextRequest('dispatch', { request_id: f.id + '-continued-correction', delivery: 'unknown' }); posts++; return 'fixed once'
  }, { completedStoryRunIds: [f.oldRun, f.runId], ordinaryCorrectionDispatch: (_proof, initialRunId) => initialRunId === f.runId })
  assert.equal(await proven(f, () => wrapped(f.id, 'model', correctionPrompt, contract, signal())), 'fixed once')
  assert.equal(posts, 1); assert.deepEqual(f.preserved(), before)
})

test('derived authority rejects stale, unknown, unbound, used or mismatched correction identities', async t => {
  for (const mode of ['no_grant', 'no_proof', 'wrong_candidate', 'wrong_base', 'wrong_initial_key', 'wrong_initial_bytes',
    'wrong_frozen_hash', 'wrong_request', 'no_format_stage', 'structure_repair', 'initial_unknown', 'initial_frozen', 'initial_unbound', 'correction_unknown', 'correction_completed'] as const) await t.test(mode, async () => {
    const f = await fixture(), proof = { ...f.proof }; let posts = 0
    if (mode === 'wrong_candidate') proof.candidate_hash = 'b'.repeat(64)
    if (mode === 'wrong_base') proof.base_input_hash = 'b'.repeat(64)
    if (mode === 'wrong_initial_key') proof.initial_request_key = 'b'.repeat(64)
    if (mode === 'wrong_initial_bytes') proof.initial_response_hash = 'b'.repeat(64)
    if (mode === 'wrong_frozen_hash') proof.correction_input_hash = 'b'.repeat(64)
    if (mode === 'initial_unknown') db.prepare("UPDATE source_model_requests SET state='dispatched',delivery='unknown' WHERE project_id=? AND request_key=?").run(f.id, f.proof.initial_request_key)
    if (mode === 'initial_unbound') db.prepare('DELETE FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').run(f.id, f.proof.initial_request_key)
    if (mode === 'initial_frozen') db.prepare(`INSERT INTO source_request_recovery_epochs
      (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`)
      .run(f.id + '-initial-frozen', f.id + '-action', f.id, f.oldRow.scope, f.proof.initial_request_key, f.runId, now())
    if (mode === 'correction_unknown' || mode === 'correction_completed') db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,?,?,?,NULL,?)`)
      .run(f.id, f.oldRow.scope, sourceDispatchRequestKey('model', correctionPrompt, contract), f.id + '-other',
        mode === 'correction_unknown' ? 'dispatched' : 'completed', mode === 'correction_unknown' ? 'unknown' : 'completed', mode === 'correction_unknown' ? null : 'old used correction', now())
    const before = f.preserved()
    const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => { posts++; return 'forbidden' }, {
      completedStoryRunIds: [f.oldRun], ...(mode === 'no_grant' ? {} : { ordinaryCorrectionDispatch: (request: DerivedSourceCorrectionRequest) =>
        request.candidate_hash === f.proof.candidate_hash && request.base_input_hash === f.proof.base_input_hash }),
    })
    const actual = mode === 'structure_repair' ? { ...contract, name: contract.name + '_structure_repair' } : contract
    const prompt = mode === 'wrong_request' ? correctionPrompt + ' drift' : correctionPrompt
    const work = () => wrapped(f.id, 'model', prompt, actual, signal())
    await assert.rejects(() => mode === 'no_proof' ? work() : mode === 'no_format_stage'
      ? withDerivedSourceCorrectionRequest(proof, 'model', prompt, actual, work) : proven(f, work, proof, correctionPrompt, actual))
    assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
  })
})

test('revocation at the derived dispatch boundary cannot consume any old permit or settle an unknown request', async () => {
  const f = await fixture(), before = f.preserved(); let allowed = true, posts = 0
  const wrapped = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
    allowed = false; notifyTextRequest('dispatch', { request_id: f.id + '-revoked', delivery: 'unknown' }); posts++; return 'forbidden'
  }, { completedStoryRunIds: [f.oldRun], ordinaryCorrectionDispatch: () => allowed })
  await assert.rejects(() => proven(f, () => wrapped(f.id, 'model', correctionPrompt, contract, signal())), (issue: any) => issue.code === 'source_request_sibling_pending')
  assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
})

test('concurrent derived callers cannot POST a second correction after the first already completed', async () => {
  const f = await fixture(), before = f.preserved(); let releaseFirst!: () => void, releaseSecond!: () => void, enteredFirst!: () => void, enteredSecond!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve }), secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve }), secondEntered = new Promise<void>(resolve => { enteredSecond = resolve })
  const options = { completedStoryRunIds: [f.oldRun], ordinaryCorrectionDispatch: () => true }; let posts = 0
  const first = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
    enteredFirst(); await firstGate; notifyTextRequest('dispatch', { request_id: f.id + '-owner', delivery: 'unknown' }); posts++; return 'one completed correction'
  }, options)
  const second = sourceModelRecovery(f.id, f.runId, f.identity, async () => {
    enteredSecond(); await secondGate; notifyTextRequest('dispatch', { request_id: f.id + '-duplicate', delivery: 'unknown' }); posts++; return 'forbidden duplicate'
  }, options)
  const firstResult = proven(f, () => first(f.id, 'model', correctionPrompt, contract, signal()))
  await firstEntered
  const secondResult = assert.rejects(() => proven(f, () => second(f.id, 'model', correctionPrompt, contract, signal())), (issue: any) => issue.code === 'source_request_sibling_pending')
  await secondEntered
  releaseFirst(); assert.equal(await firstResult, 'one completed correction')
  const key = sourceDispatchRequestKey('model', correctionPrompt, contract)
  const completed = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, key)
  releaseSecond(); await secondResult
  assert.equal(posts, 1); assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, key), completed)
  assert.deepEqual(f.preserved(), before)
})

test('the exact initial reconstruction matches the unchanged wire and checkpoint identities', async () => {
  for (const schema of [z.object({ value: z.string() }), z.array(z.string())]) {
    const prompt = 'immutable original prompt', initial = initialStructuredOutputRequest('source_identity_test', schema, prompt), checkpoint: any = {}
    await generateStructuredOutput('source_identity_test', schema, async (actualPrompt, actualContract) => {
      assert.equal(actualPrompt, initial.prompt); assert.deepEqual(actualContract, initial.contract)
      return JSON.stringify(initial.contract.wrapped ? { result: ['value'] } : { value: 'value' })
    }, prompt, { checkpoint, persistCheckpoint: () => {} })
    assert.equal(checkpoint.input_hash, initial.input_hash)
  }
})

const document = { filename: 'derived-quality.txt', content: '第一章：旧钟无人修复。' }
function stateFor(): any {
  return { story_work: { policy: 'source-story-v6', input_hash: 'legacy-derived-fixture', tasks: [] }, id: 'derived-producer', source_version: 'source-v1', model_id: 'model', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    updated_at: 'now', error: null, ordinary_story_dispatch: { run_id: 'derived-producer', binding: 'b', work_hash: 'w', protected_task_keys: [], authorized_at: 'now' },
    sections: [{ offset: 0, length: document.content.length, title: '第一章', summary: '旧钟无人修复。', characters: [], events: [], open_threads: [] }] }
}
const storyReply = (kind: string) => JSON.stringify(kind === 'overview' ? { summary: '旧钟无人修复。', ending: { summary: '资料没有结局。', section_ids: [0] }, covered_section_ids: [0] }
  : kind === 'characters' ? { characters: [] } : kind === 'timeline' ? { timeline: [], covered_section_ids: [0] } : kind === 'threads' ? { threads: [] } : { uncertainties: [] })

test('story producer replays saved initial bytes and proves only its still-unused frozen correction', async () => {
  const state = stateFor(), section = state.sections[0], initialCalls: string[] = [], correctionKeys: string[] = []; let reject = true
  const generate = async (prompt: string, contract: any) => {
    const marker = '【全剧整合资料】\n', input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    const proof = currentDerivedSourceCorrectionRequest()
    if (input.part.kind === 'overview') {
      if (!proof) { initialCalls.push(sourceDispatchRequestKey('model', prompt, contract)); return '{"summary":123}' }
      assert.equal(proof.initial_request_key, initialCalls[0]); assert.equal(proof.initial_response_hash, hash('{"summary":123}'))
      correctionKeys.push(proof.request_key)
      if (reject) throw Object.assign(new TextProviderError('not sent before correction', false), { code: 'source_request_sibling_pending', delivery: 'not_sent' })
    }
    return storyReply(input.part.kind)
  }
  const run = () => synthesizeSourceStoryParts(state, generate, () => {}, signal(), document,
    [{ covered_section_ids: [0], section: { ...section, id: 0 } }], value => sourceStorySchema.parse(value))
  await assert.rejects(run, /not sent before correction/)
  const cp = state.story_work.tasks.find((task: any) => task.key === 'overview').output_candidate.checkpoint
  assert.equal(cp.original_raw, '{"summary":123}'); assert.equal(cp.correction_started, undefined); assert.ok(cp.correction_request)
  reject = false; await run()
  assert.equal(initialCalls.length, 1); assert.equal(correctionKeys.length, 2); assert.equal(new Set(correctionKeys).size, 1)
})

test('first quality review journals the complete initial and resumes only its frozen unused correction', async () => {
  const state = stateFor(); state.story = JSON.parse(storyReply('overview')); delete state.story.covered_section_ids
  state.story = { ...state.story, characters: [], timeline: [], threads: [], uncertainties: [] }
  let reject = true, initials = 0; const correctionKeys: string[] = [], initialKeys: string[] = []
  const generate = async (prompt: string, contract: any) => {
    const proof = currentDerivedSourceCorrectionRequest()
    if (!proof) { initials++; initialKeys.push(sourceDispatchRequestKey('model', prompt, contract)); return 'not JSON' }
    assert.equal(proof.task_key, 'quality:initial'); assert.equal(proof.initial_request_key, initialKeys[0]); assert.equal(proof.initial_response_hash, hash('not JSON'))
    correctionKeys.push(proof.request_key)
    if (reject) throw Object.assign(new TextProviderError('quality correction not sent', false), { code: 'source_request_sibling_pending', delivery: 'not_sent' })
    return JSON.stringify({ checked_section_ids: [0], findings: [] })
  }
  await assert.rejects(() => reviewSourceQuality(document, state, generate, () => {}, signal()), /quality correction not sent/)
  const cp = state.quality_work.output_checkpoint
  assert.equal(cp.raw, 'not JSON'); assert.equal(cp.original_raw, 'not JSON'); assert.equal(cp.correction_started, undefined); assert.ok(cp.correction_request)
  reject = false; await reviewSourceQuality(document, state, generate, () => {}, signal())
  assert.equal(initials, 1); assert.equal(correctionKeys.length, 2); assert.equal(new Set(correctionKeys).size, 1)
  assert.equal(state.quality.status, 'passed'); assert.equal(state.quality_work, undefined)
})
