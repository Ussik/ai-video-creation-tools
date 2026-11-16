import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { currentInitialSourceQualityRequest, withInitialSourceQualityRequest, type InitialSourceQualityRequest } from '../src/modules/script/source-story-dispatch-identity.js'
import { withModelRequestContext, modelTaskPolicies } from '../src/modules/generation/model-task-policy.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { reviewSourceQuality, sourceQualityInputHash } from '../src/modules/script/script-source-quality.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-source-quality-dispatch-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, now } = await import('../src/infrastructure/database/db.js')
const { sourceModelRecovery } = await import('../src/modules/script/source-model-recovery.js')
const { notifyTextRequest } = await import('../src/infrastructure/providers/text-request-plan.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const candidate_hash = 'a'.repeat(64)
let sequence = 0

async function fixture() {
  const id = 'independent-quality-' + sequence++, oldRun = id + '-old', newRun = id + '-new', stamp = now()
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, id, stamp, stamp)
  const identity = { source: 'source-' + id, model: 'model', configuration: 'same' }
  const old = sourceModelRecovery(id, oldRun, identity, async () => {
    notifyTextRequest('dispatch', { request_id: id + '-old', delivery: 'unknown' })
    throw new Error('old unknown response')
  })
  await assert.rejects(old(id, 'model', 'old correction', { name: 'script_source_story_uncertainties', schema: { type: 'object' } }, new AbortController().signal), /old unknown/)
  const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').get(id) as any
  db.prepare(`INSERT INTO source_request_recovery_actions
    (id,project_id,client_action_id,request_digest,original_digest,original_snapshot,analysis_binding,target_run_id,decision,created_at)
    VALUES (?,?,?,'digest','original','{}','binding',?,'abandon_and_resume',?)`).run(id + '-action', id, id + '-client', newRun, stamp)
  db.prepare(`INSERT INTO source_request_recovery_epochs
    (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at)
    VALUES (?,?,?,?,?,?,'prepared','not_sent',?)`).run(id + '-epoch', id + '-action', id, original.scope, original.request_key, newRun, stamp)
  const preserved = () => ({
    original: db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key=?').get(id, original.request_key),
    epochs: db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=?').all(id),
    actions: db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=?').all(id),
    resolutions: db.prepare('SELECT * FROM source_request_recovery_resolutions WHERE project_id=?').all(id),
  })
  return { id, oldRun, newRun, identity, original, preserved }
}
const contractFor = (page = false) => ({ name: page ? 'script_source_quality_page' : 'script_source_quality', schema: { type: 'object' } })
function call(f: Awaited<ReturnType<typeof fixture>>, wrapped: ReturnType<typeof sourceModelRecovery>, page = false,
  proof: Partial<InitialSourceQualityRequest> = {}, prompt = 'new independent quality') {
  const contract = contractFor(page)
  return withInitialSourceQualityRequest({ task_key: page ? 'quality:page' : 'quality:initial', candidate_hash, ...proof },
    'model', prompt, contract, () => wrapped(f.id, 'model', prompt, contract, new AbortController().signal))
}

test('each authorized initial quality request or page keeps the old prepared sibling permit unchanged', async t => {
  for (const page of [false, true]) await t.test(page ? 'page' : 'direct', async () => {
    const f = await fixture(), before = f.preserved(); let posts = 0, checks = 0
    const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
      notifyTextRequest('dispatch', { request_id: f.id + '-fresh', delivery: 'unknown' }); posts++
      return 'complete independent review'
    }, { completedStoryRunIds: [f.oldRun], ordinaryQualityDispatch: proof => {
      checks++; assert.equal(proof.task_key, page ? 'quality:page' : 'quality:initial'); assert.equal(proof.candidate_hash, candidate_hash); return true
    } })
    assert.equal(await call(f, wrapped, page), 'complete independent review')
    assert.equal(posts, 1); assert.ok(checks >= 2); assert.deepEqual(f.preserved(), before)
    const fresh = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND request_key!=?').all(f.id, f.original.request_key) as any[]
    assert.equal(fresh.length, 1); assert.equal(fresh[0].state, 'completed')
  })
})

test('ordinary quality proof cannot authorize another kind, contract, model, old request or format correction', async t => {
  for (const mode of ['no_grant', 'no_proof', 'wrong_kind', 'wrong_candidate', 'wrong_model', 'wrong_schema', 'quality_repair', 'direct_correction', 'page_correction', 'old_unknown'] as const) await t.test(mode, async () => {
    const f = await fixture(), before = f.preserved(); let posts = 0
    const options = { completedStoryRunIds: [f.oldRun], ...(mode === 'no_grant' ? {} : {
      ordinaryQualityDispatch: (proof: InitialSourceQualityRequest) => proof.candidate_hash === candidate_hash,
    }) }
    const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => { posts++; return 'forbidden' }, options)
    const page = mode === 'page_correction', contract = contractFor(page)
    const prompt = 'new independent quality'
    const actual = mode === 'quality_repair' ? { ...contract, name: 'script_source_quality_repair' }
      : contract
    if (mode === 'old_unknown') db.prepare(`INSERT INTO source_model_requests
      (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,'dispatched','unknown',NULL,NULL,?)`)
      .run(f.id, f.original.scope, digest(['model', prompt, actual]), f.oldRun, now())
    const work = () => wrapped(f.id, mode === 'wrong_model' ? 'other' : 'model', prompt, actual, new AbortController().signal)
    const proven = () => mode === 'no_proof' ? work() : withInitialSourceQualityRequest({
      task_key: mode === 'wrong_kind' ? 'quality:page' : page ? 'quality:page' : 'quality:initial',
      candidate_hash: mode === 'wrong_candidate' ? 'b'.repeat(64) : candidate_hash,
    }, mode === 'wrong_model' ? 'other' : 'model', prompt, mode === 'wrong_schema' ? { ...actual, schema: { type: 'string' } } : actual, work)
    await assert.rejects(() => mode.endsWith('_correction')
      ? withModelRequestContext({ policy: modelTaskPolicies.review, operationStage: 'format_correction' }, proven) : proven())
    assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
  })
})

test('a quality ordinary grant revoked at the dispatch boundary creates no POST or sibling resolution', async () => {
  const f = await fixture(), before = f.preserved(); let allowed = true, posts = 0
  const wrapped = sourceModelRecovery(f.id, f.newRun, f.identity, async () => {
    allowed = false
    notifyTextRequest('dispatch', { request_id: f.id + '-revoked', delivery: 'unknown' }); posts++
    return 'forbidden'
  }, { completedStoryRunIds: [f.oldRun], ordinaryQualityDispatch: () => allowed })
  await assert.rejects(() => call(f, wrapped), (error: any) => error.code === 'source_request_sibling_pending')
  assert.equal(posts, 0); assert.deepEqual(f.preserved(), before)
})

const document = { filename: 'quality-proof.txt', content: '第一章：旧钟无人修复。' }
function qualityState(): any {
  return { id: 'quality-proof', source_version: 'source-v1', model_id: 'model', status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1,
    updated_at: 'now', error: null, sections: [{ offset: 0, length: document.content.length, title: '第一章', summary: '旧钟无人修复。', characters: [], events: [], open_threads: [] }],
    story: { summary: '旧钟无人修复。', ending: { summary: '资料没有结局。', section_ids: [0] }, characters: [], timeline: [], threads: [], uncertainties: [] } }
}
const valid = { checked_section_ids: [0], findings: [] }

test('quality producer proves its first direct attempt but never its bounded correction', async () => {
  const state = qualityState(), hash = sourceQualityInputHash(state); let calls = 0
  await reviewSourceQuality(document, state, async (prompt, contract) => {
    const proof = currentInitialSourceQualityRequest()
    if (++calls === 1) {
      assert.deepEqual(proof, { task_key: 'quality:initial', candidate_hash: hash, request_key: digest(['model', prompt, contract]) })
      return 'not JSON'
    }
    assert.equal(proof, undefined); return JSON.stringify(valid)
  }, () => {}, new AbortController().signal)
  assert.equal(calls, 2); assert.equal(currentInitialSourceQualityRequest(), undefined)
})

test('output-limited first quality review gives each fresh page its own proof and excludes page corrections', async () => {
  const state = qualityState(), hash = sourceQualityInputHash(state), pageKeys: string[] = []; let direct = 0, pages = 0
  await reviewSourceQuality(document, state, async (prompt, contract) => {
    const proof = currentInitialSourceQualityRequest()
    if (contract!.name === 'script_source_quality') {
      direct++; assert.equal(proof?.task_key, 'quality:initial')
      throw new TextOutputLimitError('{"findings":[', 'length')
    }
    assert.equal(contract!.name, 'script_source_quality_page')
    if (++pages === 2) { assert.equal(proof, undefined); return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: false }) }
    assert.deepEqual(proof, { task_key: 'quality:page', candidate_hash: hash, request_key: digest(['model', prompt, contract]) })
    pageKeys.push(proof!.request_key)
    return pages === 1 ? '{"items":[]}' : JSON.stringify({ items: [], complete: true })
  }, () => {}, new AbortController().signal)
  assert.equal(direct, 1); assert.equal(pages, 3); assert.equal(new Set(pageKeys).size, 2)
})

test('a review after completed findings or a repair never impersonates the first independent quality review', async () => {
  const state = qualityState(), hash = sourceQualityInputHash(state)
  state.quality = { input_hash: hash, status: 'issues', findings: [{ kind: 'unsupported', explanation: '旧核对意见。', unit_ids: [0] }] }
  let calls = 0
  await reviewSourceQuality(document, state, async () => { calls++; assert.equal(currentInitialSourceQualityRequest(), undefined); return JSON.stringify(valid) }, () => {}, new AbortController().signal)
  assert.equal(calls, 1)
})
