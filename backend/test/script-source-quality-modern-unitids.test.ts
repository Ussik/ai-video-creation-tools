import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { OutputContract, StructuredGenerator } from '../src/modules/generation/model-output.js'

const directory = await mkdtemp(join(tmpdir(), 'source-modern-unitids-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now } = await import('../src/infrastructure/database/db.js')
const { repairSourceQuality, sourceQualityRepairProgress } = await import('../src/modules/script/script-source-quality-repair.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { scriptSourcePassages } = await import('../src/modules/script/script-source-map.js')
const { withLocalModelReplayOnly } = await import('../src/modules/generation/model-request-admission.js')
const { CompletedOutputReplayMiss } = await import('../src/modules/generation/model-output.js')
const { initSourceModelRecovery, sourceModelCompletedReader } = await import('../src/modules/script/source-model-recovery.js')
const { sourceRecoveryDigest } = await import('../src/modules/script/source-request-recovery.js')
initDb(); initSourceModelRecovery()
assert.ok(db.name.startsWith(directory), 'modern-field replay tests must never open business data')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const source = { filename: 'redundant-modern-fields.txt', content: '旧钟无人修复。\n归来的旅人停在钟楼前。\n' }
const units = scriptSourcePassages(source.content).flatMap(item => item.units).filter(unit => unit.text.trim())
const signal = () => new AbortController().signal
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function correctionDiagnostic(prompt: string) {
  const full = prompt.split('【一次格式修正】\n上次结果未采用，原因：')[1]?.split('\n上次输出是待修正资料')[0]
  const structural = prompt.split('修复原因：')[1]?.split('\n\n【原始任务与资料】')[0]
  assert.ok(full || structural, 'a saved invalid candidate reaches normal correction diagnosis')
  return full || structural!
}
function fixture(): ScriptSourceAnalysis {
  const state: ScriptSourceAnalysis = { id: 'modern-unitids', source_version: 'synthetic-source', model_id: 'synthetic-model',
    status: 'failed', phase: 'synthesis', updated_at: 'synthetic-stamp', completed_chunks: 1, total_chunks: 1, error: null,
    sections: [{ offset: 0, length: source.content.length, title: '钟楼', episode_number: null, summary: source.content, characters: [], events: [], open_threads: [] }],
    story: { summary: source.content.trimEnd(), characters: [], timeline: [], threads: [], ending: { summary: '旅人停在钟楼前。', section_ids: [0] },
      uncertainties: [{ description: '旧钟无人修复，旅人必然准备修钟。', section_ids: [0] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: 'unsupported',
    explanation: '保留原文明示事实，不推定旅人的意图。', unit_ids: [units[0]!.id] }] }
  return state
}
async function prime(state: ScriptSourceAnalysis) {
  let providerCalls = 0, contract: OutputContract | undefined, prompt = ''
  const generate: StructuredGenerator = async () => { providerCalls++; assert.fail('local replay must not enter a provider') }
  generate.readCompleted = async (text, value) => { prompt = text; contract = value; return undefined }
  await assert.rejects(withLocalModelReplayOnly(() => repairSourceQuality(source, state, generate, () => {}, signal())), CompletedOutputReplayMiss)
  assert.equal(providerCalls, 0); assert.ok(contract)
  return { generate, contract, prompt, calls: () => providerCalls }
}
function modern(state: ScriptSourceAnalysis, overrides: Record<string, unknown> = {}) {
  return { decision: 'modify_analysis', finding_hash: hash(state.quality!.findings[0]), status: null,
    reason: '保留旧钟与旅人的观察事实，不将未说明的意图作为已知。',
    changes: [{ target: 'story.uncertainties', section_id: null, operation: 'replace', index: 0,
      expected: state.story!.uncertainties[0], value: { description: '原文未说明旅人的来意，待作者确认。', section_ids: [0] } }],
    analysis_refs: [{ path: 'story.uncertainties[0].description' }], source_refs: [{ unit_id: units[0]!.id }],
    unit_ids: [units[0]!.id], ...overrides }
}

test('modern redundant-field support preserves the existing initial wire contract identity', async () => {
  const state = fixture()
  // Reproduce the exact pre-change identity fixture; no response is applied.
  delete state.sections[0]!.episode_number
  state.story!.summary = source.content
  state.quality!.input_hash = sourceQualityInputHash(state)
  const seeded = await prime(state)
  assert.equal(hash(seeded.contract.schema), '745bb2cd9ab91fd4c971f08c4a2ad19375d2a553f5508552c72b40a57e35a5b8')
  assert.equal(state.quality_repair_output!.checkpoint.input_hash, 'c430212f73260ee67a4f61062dc5c382e2ec63b9319a94d785fa1f3fe983b1a2')
})

test('a saved complete modern proposal with exactly redundant unit_ids is reused locally with all original bytes retained', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('saved response replay cannot use network'))
  const state = fixture(), original = structuredClone(state), seeded = await prime(state)
  const raw = JSON.stringify(modern(state)), projectId = newId(), stamp = now()
  const identity = { source: state.source_version, model: state.model_id, configuration: 'saved-response-fixture' }
  const scope = sourceRecoveryDigest(identity), key = sourceRecoveryDigest([state.model_id, seeded.prompt, seeded.contract])
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(projectId, 'isolated saved raw', stamp, stamp)
  db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,updated_at)
    VALUES (?,?,?,?,'completed','completed',?,?)`).run(projectId, scope, key, state.id, raw, stamp)
  const ledger = db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(projectId)
  const completed = sourceModelCompletedReader(projectId, state.id, identity)
  seeded.generate.readCompleted = (prompt, contract) => completed(projectId, state.model_id, prompt, contract, signal())
  await withLocalModelReplayOnly(() => repairSourceQuality(source, state, seeded.generate, () => {}, signal()))
  assert.equal(seeded.calls(), 0); assert.equal(sourceQualityRepairProgress(state), 1)
  assert.equal(state.quality_repair!.decisions![0]!.decision, 'modify_analysis')
  assert.deepEqual(state.story, { ...original.story, uncertainties: [{ description: '原文未说明旅人的来意，待作者确认。', section_ids: [0] }] })
  assert.deepEqual(state.sections, original.sections); assert.deepEqual(state.quality, original.quality)
  const retained = state.quality_repair_outputs![0]!.checkpoint
  assert.equal(retained.original_raw, raw)
  assert.deepEqual(JSON.parse(retained.raw!), (() => { const { status: _status, unit_ids: _ids, ...canonical } = modern(original); return canonical })())
  assert.deepEqual(db.prepare('SELECT * FROM source_model_requests WHERE project_id=?').all(projectId), ledger, 'paid raw ledger stays byte-for-byte unchanged')
  assert.equal(retained.correction, undefined); assert.equal(retained.correction_started, undefined); assert.equal(retained.correction_request, undefined)
})

test('conflicting, duplicated, partial or extra modern fields remain rejected during saved-only replay', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('saved invalid replay cannot use network'))
  for (const mode of ['different', 'reordered', 'duplicated legacy', 'duplicated refs', 'partial', 'extra root', 'extra ref', 'mixed legacy status'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone(state.story), seeded = await prime(state), body = modern(state)
    if (mode === 'different') body.unit_ids = [units[1]!.id]
    if (mode === 'reordered') { body.source_refs.push({ unit_id: units[1]!.id }); body.unit_ids = [units[1]!.id, units[0]!.id] }
    if (mode === 'duplicated legacy') body.unit_ids.push(units[0]!.id)
    if (mode === 'duplicated refs') { body.unit_ids.push(units[0]!.id); body.source_refs.push({ unit_id: units[0]!.id }) }
    if (mode === 'partial') body.source_refs.push({ unit_id: units[1]!.id })
    if (mode === 'extra root') Object.assign(body, { arbitrary_evidence: true })
    if (mode === 'extra ref') Object.assign(body.source_refs[0]!, { arbitrary_evidence: true })
    if (mode === 'mixed legacy status') Object.assign(body, { status: 'patched' })
    const raw = JSON.stringify(body), cp = state.quality_repair_output!.checkpoint
    cp.raw = raw; cp.original_raw = raw
    const lookups: string[] = []
    seeded.generate.readCompleted = async prompt => { lookups.push(prompt); return undefined }
    await assert.rejects(withLocalModelReplayOnly(() => repairSourceQuality(source, state, seeded.generate, () => {}, signal())), CompletedOutputReplayMiss)
    assert.equal(lookups.length, 1, 'the saved initial bytes reach bounded correction diagnosis')
    const field = mode.startsWith('extra') ? 'arbitrary_evidence' : mode === 'mixed legacy status' ? 'status' : 'unit_ids'
    assert.match(correctionDiagnostic(lookups[0]!), new RegExp(`${field}[^\\n]*Schema 未定义的多余字段`))
    assert.equal(seeded.calls(), 0); assert.equal(sourceQualityRepairProgress(state), 0); assert.deepEqual(state.story, original)
    assert.equal(cp.original_raw, raw); assert.equal(cp.raw, raw); assert.equal(cp.correction, undefined)
    assert.equal(cp.correction_started, undefined); assert.equal(cp.correction_request, undefined)
  })
})

test('redundant legacy IDs do not weaken modern finding, source, path or target gates', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('saved invalid replay cannot use network'))
  for (const mode of ['finding', 'source', 'missing path', 'uncovered path', 'target'] as const) await t.test(mode, async () => {
    const state = fixture(), original = structuredClone({ story: state.story, sections: state.sections }), seeded = await prime(state)
    const body = modern(state)
    if (mode === 'finding') body.finding_hash = 'a'.repeat(64)
    if (mode === 'source') { body.source_refs = [{ unit_id: 99999 }]; body.unit_ids = [99999] }
    if (mode === 'missing path') body.analysis_refs = [{ path: 'story.uncertainties[999].description' }]
    if (mode === 'uncovered path') body.analysis_refs = [{ path: 'story.summary' }]
    if (mode === 'target') Object.assign(body.changes[0]!, { target: 'story.private_field' })
    const raw = JSON.stringify(body), cp = state.quality_repair_output!.checkpoint, diagnostics: string[] = []
    cp.raw = raw; cp.original_raw = raw
    seeded.generate.readCompleted = async prompt => { diagnostics.push(prompt); return undefined }
    await assert.rejects(withLocalModelReplayOnly(() => repairSourceQuality(source, state, seeded.generate, () => {}, signal())), CompletedOutputReplayMiss)
    assert.equal(diagnostics.length, 1)
    const expected = { finding: /finding_hash必须逐字复制/, source: /source_refs必须引用本次完整原文真实非空句段/,
      'missing path': /质量问题位置不存在/, 'uncovered path': /必须覆盖全部实际修改位置/, target: /changes\[0\]\.target/ }[mode]
    assert.match(correctionDiagnostic(diagnostics[0]!), expected)
    assert.equal(seeded.calls(), 0); assert.equal(sourceQualityRepairProgress(state), 0)
    assert.deepEqual({ story: state.story, sections: state.sections }, original)
    assert.equal(cp.original_raw, raw); assert.equal(cp.raw, raw)
    assert.equal(cp.correction, undefined); assert.equal(cp.correction_started, undefined); assert.equal(cp.correction_request, undefined)
  })
})

test('a branch mismatch follows the existing single format correction instead of throwing a nested ZodError', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('synthetic correction must stay offline'))
  const state = fixture(), first = JSON.stringify(modern(state, { unit_ids: [units[1]!.id] }))
  const { unit_ids: _redundant, status: _status, ...corrected } = modern(state)
  let calls = 0
  await repairSourceQuality(source, state, async (prompt, contract) => {
    calls++
    assert.equal(contract!.name, 'script_source_quality_repair')
    if (calls === 1) return first
    assert.equal(calls, 2)
    assert.match(correctionDiagnostic(prompt), /unit_ids[^\n]*Schema 未定义的多余字段/)
    return JSON.stringify(corrected)
  }, () => {}, signal())
  assert.equal(calls, 2); assert.equal(sourceQualityRepairProgress(state), 1)
  const cp = state.quality_repair_outputs![0]!.checkpoint
  assert.equal(cp.original_raw, first)
  assert.equal(cp.correction!.raw, JSON.stringify(corrected))
  assert.deepEqual(JSON.parse(cp.raw!), corrected)
})

test('legacy patched keeps its own unit_ids semantics and withdrawn is never reinterpreted as a modern decision', async t => {
  for (const status of ['patched', 'withdrawn'] as const) await t.test(status, async () => {
    const state = fixture(), original = structuredClone(state.story), seeded = await prime(state)
    const modernBody = modern(state), raw = JSON.stringify({ status, reason: '仅保留该旧协议分支的既有含义。',
      changes: status === 'patched' ? modernBody.changes : [], unit_ids: [units[0]!.id] })
    const cp = state.quality_repair_output!.checkpoint; cp.raw = raw; cp.original_raw = raw
    const run = () => withLocalModelReplayOnly(() => repairSourceQuality(source, state, seeded.generate, () => {}, signal()))
    if (status === 'patched') { await run(); assert.equal(sourceQualityRepairProgress(state), 1); assert.equal(state.quality_repair!.decisions![0]!.decision, 'modify_analysis') }
    else { await assert.rejects(run(), { code: 'source_quality_legacy_decision' }); assert.equal(sourceQualityRepairProgress(state), 0); assert.deepEqual(state.story, original) }
    assert.equal(seeded.calls(), 0)
    assert.equal((state.quality_repair_output || state.quality_repair_outputs![0])!.checkpoint.original_raw, raw)
  })
})
