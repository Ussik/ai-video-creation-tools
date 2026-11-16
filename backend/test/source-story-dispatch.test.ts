import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { withInitialSourceStoryRequest, currentInitialSourceStoryRequest } from '../src/modules/script/source-story-dispatch-identity.js'
const dataDir = await mkdtemp(join(tmpdir(), 'studio-source-story-dispatch-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
const { synthesizeSourceStoryParts, sourceStorySchema } = await import('../src/modules/script/script-source-story-parts.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const contract = { name: 'script_source_story_characters_merge', schema: { type: 'object' } }
const binding = { task_key: 'characters_merge:independent', candidate_hash: 'a'.repeat(64) }
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
let sequence = 0

async function fixture(activeUnknown = false) {
  const id = 'independent-story-' + sequence++, oldRun = id + '-old', newRun = id + '-new', stamp = now()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  const identity = { source: 'source-' + id, model: 'model', configuration: 'same' }
  const oldContract = { name: 'script_source_story_uncertainties', schema: { type: 'object' } }
  let oldPosts = 0
  const old = sourceModelRecovery(id, oldRun, identity, async () => {
    notifyTextRequest('dispatch', { request_id: id + '-unknown-' + oldPosts++, delivery: 'unknown' })
    throw new Error('old accepted response unknown')
  })
  await assert.rejects(old(id, 'model', 'original old correction', oldContract, new AbortController().signal), /old accepted/)
  const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(id) as any
  if (activeUnknown) await assert.rejects(old(id, 'model', 'another live unknown', oldContract, new AbortController().signal), /old accepted/)
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', newRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, original.scope, original.request_key, newRun, stamp)
  const args = [id, 'model', 'new independent merge', contract, new AbortController().signal] as const
  const oldEvidence = () => ({
    old: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, original.request_key),
    epoch: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=? ORDER BY sequence').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id),
  })
  return { id, oldRun, newRun, identity, original, args, oldEvidence }
}
const proofCall = (f: Awaited<ReturnType<typeof fixture>>, generate: ReturnType<typeof sourceModelRecovery>) =>
  withInitialSourceStoryRequest(binding, f.args[1], f.args[2], f.args[3], () => generate(...f.args))

test('an explicitly authorized initial story task dispatches independently without consuming or superseding its sibling permit', async () => {
  const f = await fixture(), before = f.oldEvidence()
  let posts = 0, checks = 0
  const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
    notifyTextRequest('dispatch', { request_id: f.id + '-fresh', delivery: 'unknown' }); posts++
    return 'new merge result'
  }, { completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: request => {
    checks++; assert.deepEqual(request, { ...binding, request_key: digest(f.args.slice(1, 4)) }); return true
  } })
  assert.equal(await proofCall(f, wrapped), 'new merge result')
  assert.equal(posts, 1); assert.ok(checks >= 2)
  assert.deepEqual(f.oldEvidence(), before)
  const fresh = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key!=?').all(f.id, f.original.request_key) as any[]
  assert.equal(fresh.length, 1); assert.equal(fresh[0].state, 'completed'); assert.equal(fresh[0].run_id, f.newRun)
  assert.equal((db.prepare('SELECT count(*) AS n FROM source_request_dispatch_links WHERE project_id=? AND request_key=?').get(f.id, fresh[0].request_key) as any).n, 1)
})

test('missing, stale or mismatched initial proof cannot turn a sibling permit into ordinary authority', async t => {
  for (const mode of ['no_grant', 'no_proof', 'wrong_model_proof', 'wrong_model_arguments', 'wrong_contract_proof', 'wrong_candidate', 'repair_contract'] as const) await t.test(mode, async () => {
    const f = await fixture(), before = f.oldEvidence()
    const options = mode === 'no_grant' ? { completedStoryRunIds: [f.oldRun] } : {
      completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: (request: any) => mode !== 'wrong_candidate' || request.candidate_hash !== binding.candidate_hash,
    }
    const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => assert.fail('must not dispatch'), options)
    const call = () => wrapped(...f.args)
    const repair = { ...contract, name: contract.name + '_structure_repair' }
    const run = () => mode === 'no_proof' ? call() : mode === 'wrong_model_arguments'
      ? withInitialSourceStoryRequest(binding, 'other-model', f.args[2], contract, () => wrapped(f.id, 'other-model', f.args[2], contract, f.args[4]))
      : withInitialSourceStoryRequest(binding,
      mode === 'wrong_model_proof' ? 'other-model' : f.args[1], f.args[2],
      mode === 'wrong_contract_proof' ? { ...contract, schema: { type: 'string' } } : mode === 'repair_contract' ? repair : f.args[3],
      mode === 'repair_contract' ? () => wrapped(f.id, 'model', f.args[2], repair, f.args[4]) : call)
    await assert.rejects(run, (error: any) => error.code === 'source_request_sibling_pending')
    assert.deepEqual(f.oldEvidence(), before)
    assert.equal((db.prepare('SELECT count(*) AS n FROM source_model_requests WHERE project_id=?').get(f.id) as any).n, 1)
  })
})

test('independent authority does not release an unacknowledged unknown sibling', async () => {
  const f = await fixture(true), before = f.oldEvidence()
  const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => assert.fail('must remain blocked'), {
    completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: () => true,
  })
  await assert.rejects(() => proofCall(f, wrapped), (error: any) => error.code === 'source_request_sibling_pending')
  assert.deepEqual(f.oldEvidence(), before)
})

test('ordinary story authority is checked again at actual dispatch and never creates a sibling resolution', async () => {
  const f = await fixture(), before = f.oldEvidence()
  let allowed = true, posts = 0
  const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
    allowed = false
    notifyTextRequest('dispatch', { request_id: f.id + '-stale', delivery: 'unknown' }); posts++
    return 'must not be sent'
  }, { completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: () => allowed })
  await assert.rejects(() => proofCall(f, wrapped), (error: any) => error.code === 'source_request_sibling_pending')
  assert.equal(posts, 0); assert.deepEqual(f.oldEvidence(), before)
  const fresh = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key!=?').all(f.id, f.original.request_key) as any[]
  assert.ok(fresh.every(row => row.delivery === 'not_sent'))
})

test('a concurrent blocked ordinary caller cannot settle another caller\'s unknown dispatched request', async () => {
  const f = await fixture()
  let releaseFirst!: () => void, releaseSecond!: () => void, enteredFirst!: () => void, enteredSecond!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve })
  const secondEntered = new Promise<void>(resolve => { enteredSecond = resolve })
  let posts = 0
  const options = { completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: () => true }
  const first = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
    enteredFirst(); await firstGate
    notifyTextRequest('dispatch', { request_id: f.id + '-owner', delivery: 'unknown' }); posts++
    throw new Error('first accepted request lost its response')
  }, options)
  const second = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
    enteredSecond(); await secondGate
    notifyTextRequest('dispatch', { request_id: f.id + '-duplicate', delivery: 'unknown' }); posts++
    return 'duplicate forbidden'
  }, options)
  const firstResult = assert.rejects(() => proofCall(f, first), /first accepted request/)
  await firstEntered
  const secondResult = assert.rejects(() => proofCall(f, second), (error: any) => error.code === 'source_request_sibling_pending')
  await secondEntered
  releaseFirst(); await firstResult
  const select = () => db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(f.id, digest(f.args.slice(1, 4))) as any
  const unknown = select(); assert.equal(unknown.state, 'dispatched'); assert.equal(unknown.delivery, 'unknown')
  releaseSecond(); await secondResult
  assert.equal(posts, 1)
  assert.deepEqual(select(), unknown, 'a rejected duplicate must not overwrite the real unknown request with not_sent')
})

test('an initial proof cannot bypass its own dispatched request or frozen identity', async t => {
  for (const own of ['dispatched', 'superseded'] as const) await t.test(own, async () => {
    const f = await fixture(), key = digest(f.args.slice(1, 4)), stamp = now()
    db.prepare("INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)")
      .run(f.id, f.original.scope, key, f.oldRun, stamp)
    if (own === 'superseded') db.prepare("INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'superseded','not_sent',?)")
      .run(f.id + '-frozen', f.id + '-action', f.id, f.original.scope, key, f.newRun, stamp)
    const before = f.oldEvidence()
    const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => assert.fail('cannot resend exact unknown'), {
      completedStoryRunIds: [f.oldRun], ordinaryStoryDispatch: () => true,
    })
    await assert.rejects(() => proofCall(f, wrapped))
    assert.deepEqual(f.oldEvidence(), before)
  })
})

test('story producers prove only exact initial format requests, never their corrections', async () => {
  const source = { filename: 'story.txt', content: '第一章：旧钟无人修复。' }
  const section = { offset: 0, length: source.content.length, title: '第一章', summary: '旧钟无人修复。', characters: [], events: [], open_threads: [] }
  const state: any = { id: 'proof-rounds', source_version: 'proof-source', model_id: 'model', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, sections: [section], error: null, updated_at: 'now' }
  state.story_work = { policy: 'source-story-v6', input_hash: 'legacy-dispatch-fixture', tasks: [] }
  let overview = 0, initial = 0, corrections = 0
  await synthesizeSourceStoryParts(state, async (prompt, output) => {
    const proof = currentInitialSourceStoryRequest()
    const marker = '【全剧整合资料】\n'
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
    if (input.part.kind === 'overview' && overview++ > 0) { assert.equal(proof, undefined); corrections++ }
    else {
      initial++; assert.ok(proof)
      assert.equal(proof.task_key, input.part.key)
      assert.equal(proof.request_key, digest(['model', prompt, output]))
      assert.equal(proof.candidate_hash, state.story_work.tasks.find((task: any) => task.key === input.part.key).output_candidate.context_hash)
    }
    if (input.part.kind === 'overview' && overview === 1) return '{"summary":123}'
    return JSON.stringify(input.part.kind === 'overview' ? { summary: '旧钟无人修复。', ending: { summary: '资料没有结局。', section_ids: [0] }, covered_section_ids: [0] }
      : input.part.kind === 'characters' ? { characters: [] } : input.part.kind === 'timeline' ? { timeline: [], covered_section_ids: [0] }
        : input.part.kind === 'threads' ? { threads: [] } : { uncertainties: [] })
  }, () => {}, new AbortController().signal, source, [{ covered_section_ids: [0], section: { ...section, id: 0 } }], value => sourceStorySchema.parse(value))
  assert.ok(initial >= 5); assert.equal(corrections, 1); assert.equal(currentInitialSourceStoryRequest(), undefined)
})


test('local replay scans saved siblings after a missing task and exposes normal generation instead of a replay loop', async () => {
  const { synthesizeSourceStory } = await import('../src/modules/script/script-source-story.js')
  const { sourceAnalysisFixture } = await import('./fixtures/script-source-analysis.js')
  const { withLocalModelReplayOnly } = await import('../src/modules/generation/model-request-admission.js')
  const { sourceStoryResume } = await import('../src/modules/script/script-source-story-progress.js')
  const names = Array.from({ length: 13 }, (_, n) => `人物${String.fromCharCode(0x7532 + n)}`)
  const content = names.join('、') + '。主角最后回家。' + '原稿叙事。'.repeat(8000)
  const source = { filename: 'local-scan.md', content }
  const state: any = { id: 'local-scan', source_version: 'local-scan-source', model_id: 'offline', status: 'running', analysis_mode: 'extract',
    sections: [{ offset: 0, length: content.length, title: '第1集', episode_number: 1, summary: '人物归乡。', events: [],
      characters: names.map(name => ({ name, description: '原稿人物', evidence: { offset: content.indexOf(name), quote: name } })) }],
    completed_chunks: 1, total_chunks: 1, completed_characters: content.length, error: null, updated_at: 'now' }
  let completed: any
  const candidates = new Map<string, any>()
  await synthesizeSourceStory(state, async prompt => sourceAnalysisFixture(prompt)!, () => {
    if (!state.story_work) return
    completed = structuredClone(state)
    for (const task of state.story_work.tasks) if (task.output_candidate?.checkpoint.raw) candidates.set(task.key, structuredClone(task.output_candidate))
  }, new AbortController().signal, undefined, undefined, source)
  delete completed.story
  const missing = completed.story_work.tasks.find((t: any) => t.key === 'characters:1')
  delete missing.result; delete missing.output_candidate; delete missing.context
  const later = completed.story_work.tasks.find((t: any) => t.key === 'uncertainties:0')
  delete later.result; later.output_candidate = candidates.get(later.key)
  assert.ok(later.output_candidate?.checkpoint.raw)
  let localMisses = 0
  const local = Object.assign(async () => { localMisses++; throw Object.assign(new Error('local bytes absent'), { code: 'source_local_model_required', delivery: 'not_sent', sourceOutputRecoveryBlocked: true }) },
    { readCompleted: async () => undefined })
  await assert.rejects(withLocalModelReplayOnly(() => synthesizeSourceStory(completed, local, () => {}, new AbortController().signal, undefined, undefined, source)),
    (error: any) => error.code === 'source_local_model_required')
  assert.deepEqual(later.result, { uncertainties: [] }, 'later complete sibling must be adopted during the same local pass')
  assert.equal(localMisses, 0, 'local replay must never enter the provider generator')
  completed.status = 'paused'; completed.local_validation = { model_required: true }
  assert.equal(sourceStoryResume(completed)?.action, 'continue', 'missing task uses normal generation after local scan')
  missing.output_candidate = { checkpoint: { initial_started: { request_id: 'unknown' } } }
  assert.notEqual(sourceStoryResume(completed)?.action, 'continue', 'local model-required marker cannot override an unknown request')
})
