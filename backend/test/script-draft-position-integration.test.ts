import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { test, mock } from 'node:test'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'
import type { GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { ToolCall, ToolTurn } from '../src/infrastructure/providers/text-tools.js'

// This suite deliberately forbids every database access, including temporary
// SQLite. npm test can run it without changing the project's global flags.
if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('position integration runs with database modules denied', async () => {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)], { env: childEnv, maxBuffer: 2_000_000 })
    assert.match(stdout, /# tests 25\b/); assert.match(stdout, /# fail 0\b/)
  })
} else {
  const deny = () => { throw new Error('Database access forbidden in position integration tests') }
  mock.module('../src/infrastructure/database/db.js', { namedExports: {
    db: new Proxy({}, { get: deny }), one: deny, all: deny, run: deny, required: deny,
    initDb: deny, now: deny, newId: deny, dataDir: '/tmp/no-database', mediaDir: '/tmp/no-database-media',
  } })
  const { createScriptDraftRepairContext } = await import('../src/modules/script/script-draft-repair-context.js')
  const { createRepairBatchLedger } = await import('../src/modules/script/script-draft-repair-batches.js')
  const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
  const { createDraftRepairReferences } = await import('../src/modules/script/script-draft-repair-references.js')
  const { generateScriptDraftRepairOutput } = await import('../src/modules/script/script-draft-repair-generation.js')
  const { runScriptDraftRepairTools } = await import('../src/modules/script/script-draft-repair-tools.js')
  const { TextProviderError, TextOutputLimitError, TextToolOutputLimitError } = await import('../src/infrastructure/providers/text-errors.js')
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const identity = { candidate_id: 'candidate', candidate_version: 'candidate-v1', source_version: 'source-v1' }
  const source = '有效原稿。\n\n原稿结局。'
  const finding = { source_key: 'outline', kind: 'unresolved_setting' as const, quote: '原段', explanation: '待落实', suggestion: '精确修订' }
  const draft = (): WorkflowDraft => ({ stage: 'outline', scope: 'project', episode_number: 0, scenes: [], artifacts: [
    { artifact_type: 'outline', title: '大纲', content: '相同原段。\n\n相同原段。\n\n末段😀。' },
    { artifact_type: 'world', title: '世界', content: '世界原文。' },
  ] })
  const workspace = (extra: Partial<Parameters<typeof createScriptDraftRepairContext>[0]> = {}) => createScriptDraftRepairContext({
    candidateId: identity.candidate_id, candidateVersion: identity.candidate_version, sourceVersion: identity.source_version,
    currentSource: source, draft: draft(), findings: [finding], ...extra,
  })
  const fixture = (initial: GenerationCheckpoint = { steps: {} }) => {
    let saved = structuredClone(initial)
    return { saved: () => structuredClone(saved), steps: () => createGenerationSteps({ checkpoint: saved, save: value => { saved = structuredClone(value) } }) }
  }
  const model = { id: 'configured', remote_id: 'same-model', modality: 'text' as const, protocol: 'chat_completions' as const, settings: {} }
  const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1' }
  const common = (steps?: ReturnType<typeof createGenerationSteps>) => ({ workspace: workspace(), prompt: '保留完整原稿和全部反馈', issueIds: ['one'], model, provider, resolveKey: () => '', steps })
  const patch = (context = workspace()) => ({ decisions: ['落实全部原反馈'], summary: '精确修订', source_edits: [],
    edits: [{ source_key: 'outline', paragraph_id: context.initial.documents[0]!.paragraphs[1]!.paragraph_id, replace: '第二处修订。', reason: '落实反馈' }] })
  const call = (name: string, value: unknown, id = name): ToolCall => ({ id, name, arguments: JSON.stringify(value) })
  const response = (calls: ToolCall[] = [], text = ''): ToolTurn => ({ calls, text, history: [], metrics: { request_bytes: 1 } })
  const submission = (value: unknown) => call('submit_repair_patch', { candidate_version: 'candidate-v1', source_version: 'source-v1', ...value as object })
  const batch = (edits: unknown[], complete = false) => ({ decisions: [{ issue_id: 'one', decision: '落实全部原反馈' }], summary: '精确修订', source_edits: [], edits, complete })
  const noOp = () => {}
  const ledger = (context = workspace(), steps?: ReturnType<typeof createGenerationSteps>) => createRepairBatchLedger(['one'], { test: 'exact-model-provider', identity: context.identity }, steps, (edit, only) => context.inspectEdit(edit, only))
  const errorCode = (error: unknown, code: string) => { assert.equal((error as { code?: string; diagnostic?: { code: string } }).code || (error as { diagnostic?: { code: string } }).diagnostic?.code, code); return true }
  const refsFor = (sources: { key: string; content: string }[]) => createDraftRepairReferences(sources, identity)
  const ref = (refs: ReturnType<typeof refsFor>, key: string, index = 0) => refs.documents.find(doc => doc.source_key === key)!.parts.filter((part): part is [string, string] => Array.isArray(part))[index]![0]
  const wireEdit = (refs: ReturnType<typeof refsFor>, key: string, index = 0) => ({ operation: 'replace_ref', source_key: key, ref_id: ref(refs, key, index), replace: `修订${index}。`, reason: '落实全部反馈' })
  const stage = (contract: { name: string } | undefined) => contract!.name

  test('context publishes distinct compact IDs, preserves read ownership and binds source identity', () => {
    const context = workspace(), document = context.initial.documents[0]!, original = draft()
    assert.equal(document.paragraphs.length, 3)
    assert.notEqual(document.paragraphs[0]!.paragraph_id, document.paragraphs[1]!.paragraph_id)
    assert.ok(document.paragraphs.every(item => !('text' in item)))
    assert.ok(context.initial.directory.every(item => !('content' in item) && !('paragraphs' in item)))
    assert.equal(context.search('candidate-v1', '世界').total_matches, 1)
    const world = { source_key: 'world', find: '世界原文。', replace: '世界修订。', reason: '落实' }
    assert.throws(() => context.inspectEdit(world), /尚未完整读取/)
    const read = context.read('candidate-v1', ['world']).documents[0]!
    assert.ok('paragraphs' in read && !('text' in read.paragraphs[0]!))
    assert.equal('paragraphs' in context.read('candidate-v1', ['world']).documents[0]!, false)
    const before = document.content, item = patch(context).edits[0]!
    assert.equal(context.inspectEdit({ ...item, replace: '相同原段。' }).start, before.indexOf('相同原段。', 1))
    assert.throws(() => context.assertPatch({ ...patch(context), edits: [{ ...item, replace: '相同原段。' }] }), /没有产生有效/)
    const sourceRef = refsFor([{ key: 'script-source', content: source }])
    const normalized = sourceRef.editSchema.parse(wireEdit(sourceRef, 'script-source'))
    const { source_key: _key, ...sourceEdit } = normalized
    assert.deepEqual(context.inspectEdit(sourceEdit, true), { source_key: 'script-source', start: 0, end: '有效原稿。'.length })
    assert.equal(context.sourceParagraphs()![0]!.paragraph_id, sourceEdit.paragraph_id)
    assert.throws(() => context.assertVersion('candidate-v0', 'source-v1'), /版本已变化/)
    assert.deepEqual(draft(), original)
    let stale = false
    const cas = workspace({ assertCurrent: () => { if (stale) throw Object.assign(new Error('stale'), { statusCode: 409 }) } })
    stale = true; assert.throws(() => cas.inspectEdit(item), /stale/)
  })

  test('timing metadata retains sibling context and numeric gate for paragraph edits', () => {
    const episode: WorkflowDraft = { stage: 'episode', scope: 'episode', episode_number: 1, scenes: [{ heading: '车站', location: '车站', time_of_day: '夜', characters: '林晚', action: '完整动作。', dialogue: '完整对白。', narration: '', duration: 2 }], artifacts: [{ artifact_type: 'episode_script', title: '第一集', content: '完整正文。' }] }
    const context = workspace({ draft: episode, findings: [{ ...finding, source_key: 'scene:0:duration' }] })
    assert.ok(context.initial.documents.some(item => item.source_key === 'scene:0:dialogue'))
    const duration = context.initial.documents.find(item => item.source_key === 'scene:0:duration')!
    const edit = { source_key: duration.source_key, paragraph_id: duration.paragraphs[0]!.paragraph_id, replace: '45秒', reason: '按对白估时' }
    assert.throws(() => context.inspectEdit(edit), /整数/)
    assert.doesNotThrow(() => context.inspectEdit({ ...edit, replace: '45' }))
    assert.equal(episode.scenes[0]!.duration, 2)
  })

  test('fresh whole repair normalizes candidate and source refs and replays exact completed cache', async () => {
    const sources = [{ key: 'outline', content: draft().artifacts[0]!.content }], candidate = refsFor(sources), sourceRefs = refsFor([{ key: 'script-source', content: source }]), f = fixture()
    let calls = 0
    const generate = async (_prompt: string) => { calls++; const { source_key: _key, ...sourceEdit } = wireEdit(sourceRefs, 'script-source'); return JSON.stringify({ decisions: ['落实全部原反馈'], summary: '修订', edits: [wireEdit(candidate, 'outline', 1)], source_edits: [sourceEdit] }) }
    const options = () => ({ steps: f.steps(), sources, currentSource: source, referenceIdentity: identity })
    const result = await generateScriptDraftRepairOutput('完整任务', ['one'], generate, options())
    assert.ok('paragraph_id' in result.edits[0]! && !('find' in result.edits[0]!))
    assert.ok('paragraph_id' in result.source_edits[0]! && !('find' in result.source_edits[0]!))
    await generateScriptDraftRepairOutput('完整任务', ['one'], async () => assert.fail('no paid redispatch'), options())
    assert.equal(calls, 1)
    assert.ok(f.saved().steps.repair!.input_hash)

  })

  test('whole local correction returns only failed targets and retains valid siblings and decisions', async () => {
    const sources = [{ key: 'outline', content: draft().artifacts[0]!.content }], refs = refsFor(sources), f = fixture()
    const good = wireEdit(refs, 'outline', 0), bad = { ...wireEdit(refs, 'outline', 1), ref_id: 'r:' + '0'.repeat(24) }
    const initialRaw = JSON.stringify({ decisions: ['落实全部原反馈'], summary: '保留摘要', edits: [good, bad], source_edits: [] })
    const calls: string[] = []
    const result = await generateScriptDraftRepairOutput('完整不可丢任务', ['one'], async (prompt, contract) => {
      calls.push(stage(contract))
      if (calls.length === 1) return initialRaw
      assert.equal(contract!.name, 'script_draft_repair_local_repair')
      assert.match(prompt, /edit_1/); assert.doesNotMatch(prompt, /完整不可丢任务/)
      return JSON.stringify({ edits: { repairs: { edit_1: wireEdit(refs, 'outline', 1) } } })
    }, { sources, referenceIdentity: identity, steps: f.steps() })
    assert.deepEqual(calls, ['script_draft_repair', 'script_draft_repair_local_repair'])
    assert.equal(result.edits.length, 2); assert.equal(result.edits[0]!.replace, good.replace)
    assert.deepEqual(result.decisions, ['落实全部原反馈']); assert.equal(result.summary, '保留摘要')
    assert.ok(Object.values(f.saved().steps).some(step => !!(step.value as { proposal_state?: unknown })?.proposal_state))
    assert.ok(Object.values(f.saved().steps).some(step => { const value = step.value as { original_raw?: string; correction?: { raw: string }; correction_started?: unknown }; return value?.original_raw === initialRaw && !!value.correction?.raw && !!value.correction_started }))
  })

  test('unknown initial whole request persists owner and never dispatches on restart', async () => {
    const f = fixture(), sources = [{ key: 'outline', content: '原文。' }]
    const issue = new TextProviderError('accepted disconnected', true); issue.delivery = 'accepted'
    await assert.rejects(generateScriptDraftRepairOutput('完整任务', ['one'], async () => { throw issue }, { sources, steps: f.steps() }), issue)
    let calls = 0
    await assert.rejects(generateScriptDraftRepairOutput('完整任务', ['one'], async () => { calls++; return '{}' }, { sources, steps: f.steps() }), error => errorCode(error, 'structured_initial_delivery_pending'))
    assert.equal(calls, 0)
  })

  test('unknown local correction replays raw proposal without a second paid correction', async () => {
    const f = fixture(), sources = [{ key: 'outline', content: '原文。' }], issue = new TextProviderError('correction disconnected', true); issue.delivery = 'output_started'
    let calls = 0
    await assert.rejects(generateScriptDraftRepairOutput('完整任务', ['one'], async () => { if (++calls === 1) return JSON.stringify({ decisions: ['实际决定'], summary: '摘要', source_edits: [], edits: [{ source_key: 'outline', find: '不存在', replace: '修订', reason: '落实' }] }); throw issue }, { sources, steps: f.steps() }), issue)
    assert.equal(calls, 2)
    await assert.rejects(generateScriptDraftRepairOutput('完整任务', ['one'], async () => { calls++; assert.fail('unknown correction owner cannot be bypassed by split fallback') }, { sources, steps: f.steps() }), error => errorCode(error, 'structured_correction_exhausted'))
    assert.equal(calls, 2)
  })

  test('legacy whole requires exact identity plus current mechanical revalidation', async () => {
    const prompt = '旧完整任务', old = { decisions: ['落实'], summary: '已验证旧结果', source_edits: [], edits: [{ source_key: 'world', find: '旧原文。', replace: '新原文。', reason: '落实' }] }
    const f = fixture({ steps: { repair: { input_hash: digest({ prompt }), value: old } } })
    const result = await generateScriptDraftRepairOutput(prompt, ['one'], async () => assert.fail('exact old whole should replay'), { steps: f.steps(), sources: [{ key: 'world', content: '旧原文。' }] })
    assert.deepEqual(result, old); assert.equal(f.saved().steps.repair!.input_hash, digest({ prompt }))
    const damaged = fixture({ steps: { repair: { input_hash: digest({ prompt }), value: old } } })
    let sent = ''
    await generateScriptDraftRepairOutput(prompt, ['one'], async task => { sent = task; return JSON.stringify({ ...old, edits: [{ ...old.edits[0], find: '当前原文。' }] }) }, { steps: damaged.steps(), sources: [{ key: 'world', content: '当前原文。' }] })
    assert.match(sent, /冻结段落/); assert.notEqual(damaged.saved().steps.repair!.input_hash, digest({ prompt }))
  })

  test('legacy front and tail pages reuse fixed historical wire identities and retained edits', async t => {
    const sources = [{ key: 'world', content: '冻结原段。' }], prompt = '完整技能与原反馈。\n可替换来源：' + JSON.stringify(sources)
    const edit = { source_key: 'world', find: '冻结原段。', replace: '修订原段。', reason: '落实反馈' }
    for (const [mode, marker, page] of [
      ['front', 'dd55325761532bfaddf3a4a87b5afc52a26adf6ebfd3c6afefd5eeecc85ee1d1', '5895f74ce8d71377376cd058cbdd2fa1e2f21df90c949892ea90d1fb8bfe3010'],
      ['tail', '85cedc7198b892bd01004f278d95d34be65c94d6e3587676cffa6df501ad604b', '993444f7d2158a38cba3f860e9b0427d0f7782dbf2fce46aee87e853f3cd79b4'],
    ]) await t.test(mode!, async () => {
      const f = fixture({ steps: {
        'repair:recovery': { input_hash: '18031d71fed9505f3a33d38eb9a563ff2521bbf6bdd8fcfa60ca1bc48f999100', value: 'decisions-then-edits' },
        'repair:decisions': { input_hash: '409b066d53c1811811125ddddbd32651355c73565910fb0d4704c872a3701734', value: { decisions: [{ issue_id: 'one', decision: '落实原反馈全部类别' }] } },
        'repair:edits:paging': { input_hash: marker!, value: true },
        'repair:edits:pages': { input_hash: page!, value: { items: [{ kind: 'candidate', edit }], complete: false, page_size: 8 } },
      } })
      let calls = 0
      const result = await generateScriptDraftRepairOutput(prompt, ['one'], async (sent, contract) => { calls++; assert.equal(contract!.name, 'script_draft_repair_edits_page'); assert.ok(sent.includes(JSON.stringify([{ kind: 'candidate', edit }]))); return JSON.stringify({ items: [], complete: true }) }, { sources, steps: f.steps() })
      assert.equal(calls, 1); assert.deepEqual(result.edits, [edit])
    })
  })

  test('fallback and new pagination retain closed refs and normalize repeated paragraphs', async () => {
    const sources = [{ key: 'outline', content: draft().artifacts[0]!.content }], refs = refsFor(sources), f = fixture(), calls: string[] = []
    const result = await generateScriptDraftRepairOutput('完整任务', ['one'], async (_sent, contract) => {
      calls.push(contract!.name)
      if (contract!.name === 'script_draft_repair') throw new TextOutputLimitError('', 'length')
      if (contract!.name === 'script_draft_repair_decisions') return JSON.stringify({ decisions: [{ issue_id: 'one', decision: '保留决定' }] })
      if (contract!.name === 'script_draft_repair_edits') throw new TextOutputLimitError('{"edits":[' + JSON.stringify(wireEdit(refs, 'outline', 1)) + ',{"source_key":', 'length')
      assert.equal(contract!.name, 'script_draft_repair_edits_page')
      return JSON.stringify({ items: [], complete: true })
    }, { sources, referenceIdentity: identity, steps: f.steps() })
    assert.equal(result.edits.length, 1); assert.ok('paragraph_id' in result.edits[0]!); assert.deepEqual(result.decisions, ['保留决定'])
    assert.equal(calls.length, 4)
    await generateScriptDraftRepairOutput('完整任务', ['one'], async () => assert.fail('closed pagination replays locally'), { sources, referenceIdentity: identity, steps: f.steps() })
  })

  test('ledger retains good siblings of schema and locator failures with stable IDs', () => {
    const context = workspace(), f = fixture(), first = ledger(context, f.steps()), good = patch(context).edits[0]!, bad = { source_key: 'outline', find: 'missing', replace: '修订', reason: '落实' }
    const result = first.accept(batch([good, bad, { source_key: 'world', replace: '缺定位', reason: '落实' }]), context.assertPatch, value => value)
    assert.equal(result.accepted_edits, 1); assert.equal(result.rejected_operations.length, 2)
    const ids = result.rejected_operations.map(item => item.operation_id)
    const second = ledger(context, f.steps())
    assert.deepEqual(second.pending().map(item => item.operation_id), ids)
    context.read('candidate-v1', ['world'])
    const corrected = second.accept(batch([
      { ...good, operation_id: ids[0], paragraph_id: context.initial.documents[0]!.paragraphs[0]!.paragraph_id },
      { source_key: 'world', find: '世界原文。', replace: '世界修订。', reason: '落实', operation_id: ids[1] },
    ], true), context.assertPatch, value => value)
    assert.equal(corrected.accepted_edits, 3); assert.ok(corrected.final); assert.deepEqual(second.pending(), [])
    assert.deepEqual(corrected.final!.edits[0], good)
  })

  test('accepted native operations are immutable and pending errors cannot disappear in full patches', () => {
    const context = workspace(), l = ledger(context), good = patch(context).edits[0]!
    const accepted = l.accept(batch([good]), noOp, value => value), id = accepted.accepted_operation_ids[0]
    const changed = l.accept(batch([{ ...good, operation_id: id, replace: '恶意覆盖已接受提案' }]), noOp, value => value)
    assert.equal(changed.rejected_operations[0]!.diagnostic!.code, 'accepted_operation_immutable')
    assert.equal(l.snapshot().edits[0]!.replace, good.replace)
    assert.throws(() => l.assertFinalPatch(patch(context)), error => errorCode(error, 'repair_operations_pending'))
    l.accept(batch([{ ...good, operation_id: id }]), noOp, value => value)
    assert.doesNotThrow(() => l.assertFinalPatch(patch(context)))
    assert.throws(() => l.assertFinalPatch({ ...patch(context), edits: [] }), /遗漏或改写/)
  })

  test('trusted overlap groups can merge explicitly and preserve tombstones', () => {
    const context = workspace(), l = ledger(context), base = { source_key: 'outline', reason: '落实' }
    const result = l.accept(batch([{ ...base, find: '末段', replace: '新末段' }, { ...base, find: '末段😀。', replace: '合并修订。' }]), noOp, value => value)
    assert.equal(result.accepted_edits, 0); assert.equal(result.conflict_groups.length, 1)
    const ids = result.rejected_operations.map(item => item.operation_id)
    const merged = l.accept(batch([{ ...base, operation_id: ids[0], merge_operation_ids: ids.slice(1), find: '末段😀。', replace: '完整合并修订。' }], true), context.assertPatch, value => value)
    assert.equal(merged.accepted_edits, 1); assert.ok(merged.final)
    assert.equal(l.proposals().find(item => item.operation_id === ids[1])!.status, 'merged')
    assert.throws(() => l.accept(batch([{ ...base, operation_id: ids[1], find: '末段', replace: '不可复活' }]), noOp, value => value), error => errorCode(error, 'operation_already_merged'))
  })

  test('native merge rejects group widening and can correct the same failed merge identity', () => {
    const context = workspace(), l = ledger(context), base = { source_key: 'outline', reason: '落实' }
    const initial = l.accept(batch([{ ...base, find: '末段', replace: '新末段' }, { ...base, find: '段😀', replace: '新片段' }]), noOp, value => value)
    const ids = initial.rejected_operations.map(item => item.operation_id)
    const widened = l.accept(batch([{ ...base, operation_id: ids[0], merge_operation_ids: ids.slice(1), find: '末段😀。', replace: '扩大了句号范围' }]), noOp, value => value)
    assert.equal(widened.accepted_edits, 0); assert.equal(widened.rejected_operations[0]!.diagnostic!.code, 'invalid_operation_merge')
    const exact = l.accept(batch([{ ...base, operation_id: ids[0], merge_operation_ids: ids.slice(1), find: '末段😀', replace: '精确合并原组' }], true), context.assertPatch, value => value)
    assert.equal(exact.accepted_edits, 1); assert.ok(exact.final)
  })

  test('merges cannot swallow unrelated failures or valid operations', () => {
    const context = workspace(), l = ledger(context), good = patch(context).edits[0]!
    const result = l.accept(batch([good, { source_key: 'outline', find: 'missing', replace: '修订', reason: '落实' }]), noOp, value => value)
    const failed = result.rejected_operations[0]!.operation_id
    const invalid = l.accept(batch([{ ...good, operation_id: failed, merge_operation_ids: [result.accepted_operation_ids[0]] }]), noOp, value => value)
    assert.equal(invalid.rejected_operations[0]!.diagnostic!.code, 'invalid_operation_merge')
    assert.equal(l.snapshot().edits.length, 1)
  })

  test('correction unknown keeps original owner; trusted rejection releases only current reservation', () => {
    const f = fixture(), l = ledger(workspace(), f.steps())
    l.noteFailure({ complete_raw: 'bad json' }); l.claimTurn('correction-owner', true)
    const resumed = ledger(workspace(), f.steps())
    assert.throws(() => resumed.claimTurn('another', true), error => errorCode(error, 'script_draft_native_request_unknown'))
    const rejected = new TextProviderError('not accepted', true); rejected.delivery = 'rejected'
    resumed.releaseRejectedTurn(rejected)
    assert.doesNotThrow(() => resumed.claimTurn('new-confirmed-unaccepted', true))
    resumed.recordTurn(response([], 'complete failed correction')); resumed.finishTurn()
    assert.throws(() => resumed.claimTurn('second-paid', true), error => errorCode(error, 'repair_correction_exhausted'))
    assert.deepEqual(resumed.failedSubmission()!.raw, { complete_raw: 'bad json' })
  })

  test('completed output limits shrink durably and never reset after restart', () => {
    const f = fixture()
    for (const size of [8, 4, 2, 1]) {
      const l = ledger(workspace(), f.steps()); assert.equal(l.outputPageSize(), size)
      l.claimTurn(`page-${size}`)
      const result = l.recordCompletedLimit(new TextToolOutputLimitError('length'))
      assert.equal(l.hasPendingRequest(), false); assert.equal(result.exhausted, size === 1)
    }
    assert.throws(() => ledger(workspace(), f.steps()).claimTurn('restart'), error => errorCode(error, 'repair_output_limit_exhausted'))
  })

  test('native first unknown request blocks restart and fallback without another turn', async () => {
    const f = fixture(), issue = new TextProviderError('accepted disconnected', true); issue.delivery = 'accepted'
    let calls = 0, fallbacks = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => { calls++; throw issue } }), issue)
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), resumeFallback: true, fallback: async () => { fallbacks++; return patch() }, turn: async () => { calls++; return response([], JSON.stringify(patch())) } }), error => errorCode(error, 'script_draft_native_request_unknown'))
    assert.equal(calls, 1); assert.equal(fallbacks, 0)
  })

  test('native complete response cancelled before validation replays locally without a paid turn', async () => {
    const f = fixture(), controller = new AbortController(), value = patch()
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), signal: controller.signal, turn: async () => { controller.abort(new DOMException('cancelled', 'AbortError')); return response([submission(value)]) } }), /cancelled/)
    let calls = 0
    const result = await runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => { calls++; assert.fail('complete replay must be local') } })
    assert.deepEqual(result, value); assert.equal(calls, 0)
  })

  test('native corrected full submission clears failed envelope only after all gates pass', async () => {
    const f = fixture(), value = patch(), bad = { ...value, edits: [{ ...value.edits[0]!, replace: '相同原段。' }] }
    let calls = 0, gates = 0
    const result = await runScriptDraftRepairTools({ ...common(f.steps()), validate: () => { gates++ }, turn: async () => response([submission(++calls === 1 ? bad : value)]) })
    assert.equal(calls, 2); assert.equal(gates, 2); assert.deepEqual(result, value)
    assert.equal((f.saved().steps['repair:tools:batches']!.value as { failed_submission?: unknown }).failed_submission, undefined)
  })

  test('native correction unknown cannot consume a second correction after restart', async () => {
    const f = fixture(), issue = new TextProviderError('correction unknown', true); issue.delivery = 'unknown'
    let calls = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => {
      if (++calls === 1) return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', ...batch([{ source_key: 'outline', find: 'missing', replace: '修订', reason: '落实' }]) })])
      throw issue
    } }), issue)
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => { calls++; return response() } }), error => errorCode(error, 'script_draft_native_request_unknown'))
    assert.equal(calls, 2)
  })

  test('native completed output limit shrinks without unknown intent and restarts at durable limit', async () => {
    const f = fixture(), sizes: number[] = [], issue = new TextProviderError('disconnect after shrink', true); issue.delivery = 'unknown'
    let calls = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async (_outputs, continuation) => {
      sizes.push(JSON.parse(continuation!).repair_progress.max_complete_operations)
      if (++calls === 1) throw new TextToolOutputLimitError('length')
      throw issue
    } }), issue)
    assert.deepEqual(sizes, [8, 4])
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => { calls++; return response() } }), error => errorCode(error, 'script_draft_native_request_unknown'))
    assert.equal(calls, 2)
  })

  test('native completed limit during correction consumes only its one correction across restart', async () => {
    const f = fixture(); let calls = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => {
      if (++calls === 1) return response([submission({ ...patch(), edits: [{ ...patch().edits[0]!, replace: '相同原段。' }] })])
      throw new TextToolOutputLimitError('length')
    } }), error => errorCode(error, 'script_draft_repair_stalled'))
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), turn: async () => { calls++; return response() } }), error => errorCode(error, 'repair_output_limit_exhausted'))
    assert.equal(calls, 2)
  })

  test('native semantic rejection retains private proposals and complete raw without adopting text', async () => {
    const f = fixture(), context = workspace(), value = patch(context), before = context.allDocuments()
    await assert.rejects(runScriptDraftRepairTools({ ...common(f.steps()), workspace: context, validate: () => { throw new Error('semantic gate rejects') }, turn: async () => response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', ...batch(value.edits, true) })]) }), /semantic gate rejects/)
    const state = f.saved().steps['repair:tools:batches']!.value as { operations: Array<{ status: string }>; last_turn: { raw: unknown; processed: boolean } }
    assert.equal(state.operations[0]!.status, 'valid'); assert.equal(state.last_turn.processed, false); assert.ok(state.last_turn.raw)
    assert.deepEqual(context.allDocuments(), before); assert.equal(f.saved().steps['repair:tools'], undefined)
  })
}
