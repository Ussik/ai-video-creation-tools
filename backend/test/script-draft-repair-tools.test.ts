import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
import type { ToolCall, ToolOutput, ToolTurn } from '../src/infrastructure/providers/text-tools.js'
import { TextProviderError, TextToolOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const directory = await mkdtemp(join(tmpdir(), 'candidate-repair-tools-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'repair fixtures must never open the workspace database')
const { createScriptDraftRepairContext } = await import('../src/modules/script/script-draft-repair-context.js')
const { runScriptDraftRepairTools } = await import('../src/modules/script/script-draft-repair-tools.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1' }
const model: GenerationModel = { id: 'configured', remote_id: 'any-remote-name', modality: 'text', protocol: 'chat_completions',
  settings: { stream: false, request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] } } }
const original = '原稿明确十七集，结局归还铜钥匙，人物身份保持不变。'
const draft = (): WorkflowDraft => ({ stage: 'outline', scope: 'project', episode_number: 0, scenes: [], artifacts: [
  { artifact_type: 'outline', title: '大纲', content: '大纲原文：钥匙代价未定。' },
  { artifact_type: 'world', title: '世界', content: '世界原文：铜钥匙每次只能开一扇门。' },
  { artifact_type: 'constraints', title: '禁区', content: '不得改变既定人物身份。' },
] })
const finding = { source_key: 'outline', kind: 'unresolved_setting' as const, quote: '钥匙代价未定', explanation: '使用代价未展开', suggestion: '明确使用代价' }
function workspace(options: Partial<Parameters<typeof createScriptDraftRepairContext>[0]> = {}) {
  return createScriptDraftRepairContext({ candidateId: 'candidate', candidateVersion: 'candidate-v1', sourceVersion: 'source-v1',
    draft: draft(), findings: [finding], currentSource: original, ...options })
}
function patch(key = 'outline') {
  const content = draft().artifacts.find(item => item.artifact_type === key)!.content
  return { decisions: ['铜钥匙每次使用会失去当天记忆。'], summary: '落实已经委托的钥匙代价', source_edits: [],
    edits: [{ source_key: key, find: content, replace: content.replace('未定', '每次失去当天记忆') + ' 已明确使用代价。', reason: '落实钥匙代价' }] }
}
const call = (name: string, args: unknown, id = name): ToolCall => ({ id, name, arguments: JSON.stringify(args) })
const submitted = (value = patch()) => call('submit_repair_patch', { candidate_version: 'candidate-v1', source_version: 'source-v1', ...value })
const response = (calls: ToolCall[], text = ''): ToolTurn => ({ calls, text, history: [], metrics: { request_bytes: 1 } })
const common = () => ({ workspace: workspace(), prompt: `完整原始要求和当前有效稿：${original}`, issueIds: ['issue-1'], model, provider, resolveKey: () => '' })

test('targeted context includes complete affected and related documents, while unknown locations fall back to all text', () => {
  const context = workspace({ findings: [{ ...finding, related_findings: [{ source_key: 'world', quote: '铜钥匙', explanation: '关联规则', suggestion: '同步' }] }] })
  assert.deepEqual(context.initial.documents.map(item => item.source_key), ['outline', 'world'])
  assert.equal(context.initial.context_mode, 'targeted')
  assert.equal(context.initial.documents[1]!.content, draft().artifacts[1]!.content)
  assert.ok(context.initial.directory.every(item => !('content' in item)))
  assert.equal(context.stats().loaded_chars, draft().artifacts[0]!.content.length + draft().artifacts[1]!.content.length)
  const unknown = workspace({ findings: [{ ...finding, related_findings: [{ source_key: 'unknown-global', quote: '关联', explanation: '未知全局', suggestion: '检查' }] }] })
  assert.equal(unknown.initial.context_mode, 'full')
  assert.equal(unknown.initial.documents.length, 3)
})

test('search does not authorize a patch; full reads do, versions and original bytes remain bound', () => {
  const input = draft(), before = structuredClone(input), context = workspace({ draft: input })
  assert.equal(context.search('candidate-v1', '铜钥匙').total_matches, 1)
  assert.throws(() => context.assertPatch(patch('world')), /尚未完整读取/)
  const read = context.read('candidate-v1', ['world'])
  assert.equal('content' in read.documents[0]!, true)
  assert.doesNotThrow(() => context.assertPatch(patch('world')))
  assert.equal('content' in context.read('candidate-v1', ['world']).documents[0]!, false)
  assert.throws(() => context.read('candidate-v0', ['world']), /版本已变化/)
  assert.throws(() => context.assertPatch(patch(), 'candidate-v1', 'source-v0'), /版本已变化/)
  assert.deepEqual(input, before)
})

test('patches reject ambiguity, overlap, unchanged content and absent source manuscript', () => {
  const ambiguous = workspace({ draft: { ...draft(), artifacts: [{ artifact_type: 'outline', title: '大纲', content: '钥匙。钥匙。' }] } })
  assert.throws(() => ambiguous.assertPatch({ ...patch(), edits: [{ source_key: 'outline', find: '钥匙', replace: '铜钥匙', reason: '代价' }] }), /出现多次/)
  const context = workspace(), edit = patch().edits[0]!
  assert.throws(() => context.assertPatch({ ...patch(), edits: [edit, edit] }), /相互重叠/)
  assert.throws(() => context.assertPatch({ ...patch(), edits: [{ ...edit, replace: edit.find }] }), /没有产生有效/)
  assert.throws(() => workspace({ currentSource: undefined }).assertPatch({ ...patch(), source_edits: [{ find: original, replace: original + '新增。', reason: '补齐' }] }), /没有可修改的有效稿/)
})

test('batch read then valid submission ends without an extra model summary and invokes caller validation', async () => {
  let turns = 0, validations = 0
  const value = patch('world')
  const result = await runScriptDraftRepairTools({ ...common(), validate: () => { validations++ }, turn: async outputs => {
    turns++
    if (turns === 1) return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world', 'constraints'] })])
    const read = JSON.parse(outputs![0]!.output)
    assert.equal(read.ok, true)
    assert.equal(read.result.documents.length, 2)
    assert.equal(read.result.documents[0].content, draft().artifacts[1]!.content)
    return response([submitted(value)])
  } })
  assert.deepEqual(result, value); assert.equal(turns, 2); assert.equal(validations, 1)
})

test('unread submissions receive real diagnostics and can be corrected by reading before resubmission', async () => {
  let turns = 0
  const value = patch('world')
  const result = await runScriptDraftRepairTools({ ...common(), turn: async outputs => {
    turns++
    if (turns === 1) return response([submitted(value)])
    if (turns === 2) {
      assert.equal(JSON.parse(outputs![0]!.output).diagnostic.code, 'unread_repair_source')
      return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] })])
    }
    // The same patch is legal only after a new full read has supplied evidence.
    return response([submitted(value)])
  } })
  assert.deepEqual(result, value); assert.equal(turns, 3)
})

test('complete valid JSON can finish the same response; repeated natural-language completion still requires a valid patch', async () => {
  const result = await runScriptDraftRepairTools({ ...common(), turn: async () => response([], JSON.stringify(patch())) })
  assert.deepEqual(result, patch())
  let requests = 0
  const corrected = await runScriptDraftRepairTools({ ...common(), turn: async (_outputs, continuation) => {
    requests++
    if (requests > 1) assert.match(continuation!, /尚未提交修补结果/)
    return requests < 2 ? response([], '已全部完成。') : response([], JSON.stringify(patch()))
  } })
  assert.deepEqual(corrected, patch()); assert.equal(requests, 2)
})

test('candidate repair can complete after more than six model decisions', async () => {
  let requests = 0
  const rounds: number[] = []
  const input = draft(); input.artifacts[1]!.content += Array.from({ length: 9 }, (_, index) => `证据${index + 1}。`).join('')
  const result = await runScriptDraftRepairTools({ ...common(), workspace: workspace({ draft: input }), onProgress: (_message, stats) => { if (stats.round) rounds.push(stats.round) },
    turn: async outputs => {
      requests++
      if (requests > 1) assert.equal(JSON.parse(outputs![0]!.output).ok, true)
      return requests < 10
        ? response([call('search_repair_context', { candidate_version: 'candidate-v1', query: `证据${requests}。`, source_keys: [] }, String(requests))])
        : response([submitted()])
    } })
  assert.deepEqual(result, patch()); assert.equal(requests, 10); assert.ok(rounds.includes(10))
})

test('more than sixteen tool calls in one response can reach a valid submission without another model request', async () => {
  let requests = 0
  const searches = Array.from({ length: 20 }, (_, index) => call('search_repair_context',
    { candidate_version: 'candidate-v1', query: '铜钥匙', source_keys: [] }, `search-${index}`))
  const result = await runScriptDraftRepairTools({ ...common(), turn: async () => {
    requests++; assert.equal(requests, 1, 'successful submission must finish immediately')
    return response([...searches, submitted()])
  } })
  assert.deepEqual(result, patch()); assert.equal(requests, 1)
})

test('repeated identical correctable failures stop with a retained candidate and an explicit resume can read and submit', async () => {
  let requests = 0
  const value = patch('world'), context = workspace()
  await assert.rejects(runScriptDraftRepairTools({ ...common(), workspace: context, turn: async outputs => {
    requests++
    if (requests > 1) assert.equal(JSON.parse(outputs![0]!.output).diagnostic.code, 'unread_repair_source')
    return response([submitted(value)])
  } }), (error: unknown) => (error as { code: string }).code === 'script_draft_repair_stalled')
  assert.equal(requests, 2)
  assert.deepEqual(context.initial.documents[0]!.content, draft().artifacts[0]!.content)
  let resumed = 0
  const result = await runScriptDraftRepairTools({ ...common(), workspace: context, turn: async outputs => {
    if (++resumed === 1) return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] })])
    assert.equal(JSON.parse(outputs![0]!.output).ok, true)
    return response([submitted(value)])
  } })
  assert.deepEqual(result, value); assert.equal(resumed, 2)
})

test('a no-op native patch is rejected and the model can correct it without restarting the task', async () => {
  let requests = 0
  const value = patch(); value.edits[0]!.replace = value.edits[0]!.find
  const result = await runScriptDraftRepairTools({ ...common(), turn: async outputs => {
    requests++
    if (requests === 1) return response([submitted(value)])
    const diagnostic = JSON.parse(outputs![0]!.output).diagnostic
    assert.equal(diagnostic.code, 'repair_without_changes'); assert.equal(diagnostic.retryable, true)
    return response([submitted()])
  } })
  assert.deepEqual(result, patch()); assert.equal(requests, 2)
})

test('repeated empty text, searches, already-loaded reads and no-op patches stop without depending on call IDs or wording', async t => {
  for (const kind of ['empty', 'search', 'read', 'noop', 'direct-noop']) await t.test(kind, async () => {
    let requests = 0
    const context = workspace(), before = context.allDocuments()
    await assert.rejects(runScriptDraftRepairTools({ ...common(), workspace: context, turn: async () => {
      requests++
      if (kind === 'empty') return response([], `仅声称正在处理 ${requests}`)
      if (kind === 'search') return response([call('search_repair_context', { candidate_version: 'candidate-v1', query: '铜钥匙', source_keys: [] }, `new-id-${requests}`)])
      if (kind === 'read') return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['outline'] }, `new-id-${requests}`)])
      const value = patch(); value.edits[0]!.replace = value.edits[0]!.find
      value.summary = `新的总结 ${requests}`; value.decisions = [`新的说法 ${requests}`]; value.edits[0]!.reason = `新的理由 ${requests}`
      return kind === 'direct-noop' ? response([], JSON.stringify(value)) : response([submitted(value)])
    } }), error => {
      assert.equal((error as { code: string }).code, 'script_draft_repair_stalled')
      assert.match((error as Error).message, /均已保留.*手动继续.*更换模型/)
      return true
    })
    assert.equal(requests, 2)
    assert.deepEqual(context.allDocuments(), before)
    assert.deepEqual(context.loadedSources().map(item => item.source_key), ['outline'])
  })
})

test('A to B to A tool cycles stop while different search strategies may continue and read a valid patch source', async () => {
  let cycles = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), turn: async () => {
    const query = ['铜钥匙', '身份', '铜钥匙'][cycles++]!
    return response([call('search_repair_context', { candidate_version: 'candidate-v1', query, source_keys: [] }, `cycle-${cycles}`)])
  } }), (error: unknown) => (error as { code: string }).code === 'script_draft_repair_stalled')
  assert.equal(cycles, 3)
  const context = workspace(), value = patch('world')
  let requests = 0
  const result = await runScriptDraftRepairTools({ ...common(), workspace: context, turn: async outputs => {
    requests++
    if (requests < 3) return response([call('search_repair_context', { candidate_version: 'candidate-v1', query: `无结果的不同定位${requests}`, source_keys: [] })])
    if (requests === 3) {
      assert.equal(JSON.parse(outputs![0]!.output).result.total_matches, 0)
      return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] })])
    }
    return response([submitted(value)])
  } })
  assert.deepEqual(result, value); assert.equal(requests, 4)
  assert.deepEqual(context.loadedSources().map(item => item.source_key), ['outline', 'world'])
})

test('direct JSON patches receive the same read diagnostics and can be corrected using tools', async () => {
  let requests = 0
  const value = patch('world')
  const result = await runScriptDraftRepairTools({ ...common(), turn: async (outputs, continuation) => {
    requests++
    if (requests === 1) return response([], JSON.stringify(value))
    if (requests === 2) {
      assert.equal(JSON.parse(continuation!).diagnostic.code, 'unread_repair_source')
      return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] })])
    }
    assert.equal(JSON.parse(outputs![0]!.output).ok, true)
    return response([], JSON.stringify(value))
  } })
  assert.deepEqual(result, value); assert.equal(requests, 3)
})

test('tool lifecycle records retain read, search and rejected submission diagnostics without leaking document or patch bodies', async () => {
  let requests = 0
  const events: import('../src/modules/script/script-draft-repair-tools.js').ScriptDraftRepairToolEvent[] = []
  const result = await runScriptDraftRepairTools({ ...common(), onToolEvent: event => events.push(event), turn: async () => {
    requests++
    if (requests === 1) return response([
      submitted(patch('world')),
      call('search_repair_context', { candidate_version: 'candidate-v1', query: '铜钥匙', source_keys: [] }),
      call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] }),
    ])
    assert.equal(requests, 2)
    return response([submitted(patch('world'))])
  } })
  assert.deepEqual(result, patch('world'))
  assert.deepEqual(events.map(({ name, status }) => [name, status]), [
    ['submit_repair_patch', 'running'], ['submit_repair_patch', 'failed'],
    ['search_repair_context', 'running'], ['search_repair_context', 'succeeded'],
    ['get_repair_context', 'running'], ['get_repair_context', 'succeeded'],
    ['submit_repair_patch', 'running'], ['submit_repair_patch', 'succeeded'],
  ])
  for (let index = 0; index < events.length; index += 2) assert.equal(events[index]!.id, events[index + 1]!.id)
  assert.notEqual(events[0]!.id, events[6]!.id)
  assert.match(events[1]!.summary, /尚未完整读取/)
  const serialized = JSON.stringify(events)
  for (const value of [original, draft().artifacts[1]!.content, patch('world').edits[0]!.replace, patch().decisions[0]!]) {
    assert.ok(!serialized.includes(value), 'public activity metadata must not retain source or patch text')
  }
})

test('cancellation takes priority when the model repeats an unfinished operation', async () => {
  const controller = new AbortController()
  let requests = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), signal: controller.signal, turn: async () => {
    requests++
    assert.ok(requests <= 2, 'cancelled work must not request another turn')
    if (requests === 2) controller.abort()
    return response([], '正在继续整理。')
  } }), /abort/i)
  assert.equal(requests, 2)
})

test('immediately resolved distinct tool turns yield so timer cancellation can stop ongoing exploration', async () => {
  const controller = new AbortController()
  const reason = new Error('creator cancelled through the event loop')
  let requests = 0, timer: ReturnType<typeof setTimeout> | undefined
  try {
    await assert.rejects(runScriptDraftRepairTools({ ...common(), signal: controller.signal, turn: async () => {
      requests++
      assert.ok(requests < 500, 'unfinished immediate responses must not starve cancellation timers')
      if (requests === 1) timer = setTimeout(() => controller.abort(reason), 0)
      return response([call('search_repair_context', { candidate_version: 'candidate-v1', query: `不同的定位${requests}`, source_keys: [] })])
    } }), issue => issue === reason)
    assert.ok(requests >= 1 && requests < 500)
  } finally { clearTimeout(timer) }
})

test('fallback is explicit and never masks authentication, budget, network or arbitrary provider failures', async () => {
  let fallbackCalls = 0
  const fallback = async () => { fallbackCalls++; return patch() }
  const disabled = { ...model, settings: { ...model.settings as object, tool_calling: false } }
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), model: disabled, fallback }), patch())
  assert.equal(fallbackCalls, 1)
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), fallback,
    turn: async () => { throw new TextProviderError('HTTP 400: tools are not supported', false, 'unsupported_parameter', 400) } }), patch())
  assert.equal(fallbackCalls, 2)
  for (const error of [new TextProviderError('HTTP 401: tools authentication failed', false, 'invalid_api_key', 401),
    new TextProviderError('HTTP 400: invalid model configuration', false, 'invalid_request', 400),
    new TextProviderError('HTTP 400: tools[0].function.parameters: schema keyword not supported', false, 'invalid_schema', 400),
    new Error('request budget exhausted'), new TypeError('fetch failed')]) {
    await assert.rejects(runScriptDraftRepairTools({ ...common(), fallback, turn: async () => { throw error } }), issue => issue === error)
  }
  assert.equal(fallbackCalls, 2)
})

test('actual caller validation failures propagate instead of becoming another repair attempt', async () => {
  const failure = new Error('candidate validation unavailable')
  for (const direct of [false, true]) {
    let requests = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(), validate: () => { throw failure }, turn: async () => {
      requests++; assert.equal(requests, 1)
      return direct ? response([], JSON.stringify(patch())) : response([submitted()])
    } }), issue => issue === failure)
    assert.equal(requests, 1)
  }
})

test('source and candidate versions are rechecked after every model turn, and cancellation cannot submit', async () => {
  let current = true
  const candidate = workspace({ assertCurrent: () => { if (!current) throw Object.assign(new Error('来源版本已变化'), { statusCode: 409 }) } })
  await assert.rejects(runScriptDraftRepairTools({ ...common(), workspace: candidate, turn: async () => {
    current = false; return response([submitted()])
  } }), /来源版本已变化/)
  const controller = new AbortController()
  await assert.rejects(runScriptDraftRepairTools({ ...common(), signal: controller.signal, turn: async () => {
    controller.abort(); return response([submitted()])
  } }), /abort/i)
})

test('successful checkpoints reuse exact output and failed sessions cannot retain read credentials', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, requests = 0
  const options = common()
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  const first = await runScriptDraftRepairTools({ ...options, steps: steps(), turn: async () => { requests++; return response([submitted()]) } })
  assert.ok(checkpoint.steps['repair:tools'])
  assert.deepEqual(await runScriptDraftRepairTools({ ...options, workspace: workspace(), steps: steps(), turn: async () => assert.fail('checkpoint must be reused') }), first)
  assert.equal(requests, 1)
  const candidate = workspace()
  let rounds = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), workspace: candidate, turn: async () => {
    if (++rounds === 1) return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['world'] })])
    throw new Error('interrupted')
  } }), /interrupted/)
  let restarted = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), workspace: candidate, turn: async (_outputs, continuation) => {
    if (++restarted === 1) return response([], JSON.stringify(patch('world')))
    assert.equal(JSON.parse(continuation!).diagnostic.code, 'unread_repair_source')
    throw new Error('interrupted after unread diagnostic')
  } }), /interrupted after unread diagnostic/)
  assert.equal(restarted, 2)
})

test('repair sessions preserve exact large tool evidence without spawning history summarization requests', async t => {
  const input = draft(); input.artifacts[1]!.content += '完整正文证据。'.repeat(9000)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++
    const body = JSON.parse(String(init.body))
    assert.ok(body.tools?.length, 'candidate repair must never start a hidden history-summary model request')
    if (requests === 1) {
      assert.ok(body.messages[0].content.includes(original))
      assert.ok(!body.messages[0].content.includes('完整正文证据。'))
      return Response.json({ choices: [{ message: { tool_calls: [{ id: 'read-world', type: 'function', function: {
        name: 'get_repair_context', arguments: JSON.stringify({ candidate_version: 'candidate-v1', source_keys: ['world'] }),
      } }] }, finish_reason: 'tool_calls' }] })
    }
    if (requests === 2) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'read-boundary', type: 'function', function: {
      name: 'get_repair_context', arguments: JSON.stringify({ candidate_version: 'candidate-v1', source_keys: ['constraints'] }),
    } }] }, finish_reason: 'tool_calls' }] })
    assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === 'tool' && message.content.includes('完整正文证据。'.repeat(9000))))
    return Response.json({ choices: [{ message: { content: JSON.stringify(patch()) }, finish_reason: 'stop' }] })
  })
  const result = await runScriptDraftRepairTools({ ...common(), workspace: workspace({ draft: input }) })
  assert.deepEqual(result, patch()); assert.equal(requests, 3)
})


test('native complete repair batches survive a disconnect and resume without reselecting accepted decisions', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, turns = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const accepted = patch()
  const batch = (data: object) => call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
    decisions: [], summary: '逐步落实已确认决定', edits: [], source_edits: [], complete: false, ...data })
  await assert.rejects(runScriptDraftRepairTools({ ...common(), steps: steps(), turn: async () => {
    if (++turns === 1) return response([batch({ decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }] })])
    throw new Error('later model disconnected')
  } }), /later model disconnected/)
  assert.equal(checkpoint.steps['repair:tools'], undefined)
  const saved = JSON.stringify(checkpoint.steps['repair:tools:batches'])
  assert.ok(saved.includes(accepted.decisions[0]!))
  let resumed = 0
  const result = await runScriptDraftRepairTools({ ...common(), steps: steps(), turn: async () => {
    resumed++
    return response([batch({ edits: accepted.edits, complete: true })])
  } })
  assert.equal(resumed, 1)
  assert.deepEqual(result.decisions, accepted.decisions)
  assert.deepEqual(result.edits, accepted.edits)
})

test('a native truncated submission is never executed and retries only smaller complete batches', async () => {
  let turns = 0
  const accepted = patch(), observations: string[] = []
  const result = await runScriptDraftRepairTools({ ...common(), turn: async (_outputs, continuation) => {
    turns++
    if (turns === 1) throw new TextToolOutputLimitError('length')
    observations.push(continuation!)
    return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary,
      edits: accepted.edits, source_edits: [], complete: true })])
  } })
  assert.equal(turns, 2)
  assert.match(observations[0]!, /未执行任何残缺工具/)
  assert.deepEqual(result, accepted)
})

test('accepted batches reject cross-page overlapping edits before final submission', async () => {
  const accepted = patch()
  let turns = 0, rejected = false
  await assert.rejects(runScriptDraftRepairTools({ ...common(), turn: async outputs => {
    if (++turns === 1) return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary,
      edits: accepted.edits, source_edits: [], complete: false })])
    if (turns === 3) { rejected = JSON.parse(outputs![0]!.output).ok === false; throw new Error('overlap verified') }
    return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [], summary: accepted.summary,
      edits: [{ ...accepted.edits[0]!, find: '钥匙代价未定', replace: '另一个不兼容的决定' }], source_edits: [], complete: true })])
  } }), /overlap verified/)
  assert.equal(rejected, true)
})
