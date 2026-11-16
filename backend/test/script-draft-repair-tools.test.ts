import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test, mock } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
import type { ToolCall, ToolOutput, ToolTurn } from '../src/infrastructure/providers/text-tools.js'
import { TextProviderError, TextToolOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('legacy regression suite runs with all database access denied', async () => {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--import', 'tsx', '--test', fileURLToPath(import.meta.url)], { env: childEnv, maxBuffer: 2_000_000 })
    assert.match(stdout, /# fail 0\b/)
  })
} else {
const deny = () => { throw new Error('Database access forbidden in draft repair regression tests') }
mock.module('../src/infrastructure/database/db.js', { namedExports: {
  db: new Proxy({}, { get: deny }), one: deny, all: deny, run: deny, required: deny,
  initDb: deny, now: deny, newId: deny, dataDir: '/tmp/no-database', mediaDir: '/tmp/no-database-media',
} })
const { generateScriptDraftRepairOutput, hasScriptDraftRepairCheckpoint } = await import('../src/modules/script/script-draft-repair-generation.js')
const { createScriptDraftRepairContext } = await import('../src/modules/script/script-draft-repair-context.js')
const { runScriptDraftRepairTools, scriptDraftNativeToolsAvailable } = await import('../src/modules/script/script-draft-repair-tools.js')

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

test('timing repair loads the full affected scene with editable numeric evidence and a read-only derived total', () => {
  const episode: WorkflowDraft = { stage: 'episode', scope: 'episode', episode_number: 1, target_duration: 90,
    artifacts: [{ artifact_type: 'episode_script', title: '第一集', content: '林晚在车站完整说明事故经过。' }],
    scenes: [{ heading: '车站', location: '车站', time_of_day: '夜', characters: '林晚', action: '林晚说明事故经过。',
      dialogue: '先听我说完昨晚的经过。', narration: '林晚回想起列车进站前的声音。', duration: 2 },
    { heading: '远处', location: '', time_of_day: '', characters: '', action: '信号灯闪烁。', dialogue: '', narration: '', duration: 4 }] }
  const timingFinding = { ...finding, source_key: 'scene:0:duration', quote: '2', explanation: '完整对话无法在估时内完成', suggestion: '保留对白并重新估时' }
  const context = workspace({ draft: episode, findings: [timingFinding] })
  assert.deepEqual(context.initial.documents.map(item => item.source_key), [
    'scene:0:heading', 'scene:0:location', 'scene:0:time_of_day', 'scene:0:characters',
    'scene:0:action', 'scene:0:dialogue', 'scene:0:narration', 'scene:0:duration',
  ])
  for (const field of ['heading', 'location', 'time_of_day', 'characters', 'action', 'dialogue', 'narration', 'duration'] as const) {
    assert.equal(context.initial.documents.find(item => item.source_key === `scene:0:${field}`)!.content, String(episode.scenes[0]![field]))
  }
  assert.equal(context.initial.context_mode, 'targeted')
  assert.ok(context.initial.documents.every(item => !item.source_key.startsWith('scene:1:')))
  assert.equal(context.initial.timing!.estimated_total, 6)
  assert.equal(context.initial.timing!.target_duration, 90)
  assert.match(context.initial.timing!.instructions, /不能作为补丁来源或直接修改/)
  const value = { decisions: ['按完整对白重新估为45秒。'], summary: '仅修正场次估时', source_edits: [],
    edits: [{ source_key: 'scene:0:duration', find: '2', replace: '45', reason: '保留对白并为表演留出时间' }] }
  assert.doesNotThrow(() => context.assertPatch(value))
  assert.throws(() => context.assertPatch({ ...value, edits: [{ ...value.edits[0]!, replace: '45秒' }] }), /整数/)
  assert.throws(() => context.assertPatch({ ...value, edits: [{ ...value.edits[0]!, source_key: 'timing:estimated_total' }] }), /不属于/)
  assert.equal(episode.scenes[0]!.duration, 2)
  assert.notEqual(workspace({ draft: { ...episode, target_duration: 120 }, findings: [timingFinding] }).identity, context.identity)

  const related = workspace({ draft: episode, findings: [{ ...timingFinding, source_key: 'episode_script', quote: '说明事故经过',
    related_findings: [{ source_key: 'scene:0:duration', quote: '2', explanation: timingFinding.explanation, suggestion: timingFinding.suggestion }] }] })
  assert.equal(related.initial.documents.find(item => item.source_key === 'scene:0:dialogue')!.content, episode.scenes[0]!.dialogue)
  assert.ok(related.initial.documents.every(item => !item.source_key.startsWith('scene:1:')))

  const onDemand = workspace({ draft: episode, findings: [{ ...finding, source_key: 'episode_script' }] })
  assert.equal(onDemand.initial.documents.length, 1)
  const read = onDemand.read('candidate-v1', ['scene:0:duration'])
  assert.deepEqual(read.documents.map(item => item.source_key), context.initial.documents.map(item => item.source_key))
  assert.ok(read.documents.every(item => 'content' in item))
  assert.doesNotThrow(() => onDemand.assertPatch(value))
  onDemand.resetReads()
  assert.throws(() => onDemand.assertPatch(value), /尚未完整读取/)
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
    turn: async () => { throw Object.assign(new TextProviderError('HTTP 400: tools are not supported', false, 'unsupported_parameter', 400), { delivery: 'rejected' }) } }), patch())
  assert.equal(fallbackCalls, 2)
  for (const error of [new TextProviderError('HTTP 401: tools authentication failed', false, 'invalid_api_key', 401),
    new TextProviderError('HTTP 400: tools are not supported', false, 'unsupported_parameter', 400),
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


test('native complete batches survive unknown delivery but restart does not resend the pending request', async () => {
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
  await assert.rejects(runScriptDraftRepairTools({ ...common(), steps: steps(), resumeFallback: true,
    fallback: async () => assert.fail('accepted native batches take precedence over a fallback hint'), turn: async () => {
      resumed++; return response([batch({ edits: accepted.edits, complete: true })])
    } }), (error: any) => error.code === 'script_draft_native_request_unknown')
  assert.equal(resumed, 0)
  assert.equal(JSON.stringify(checkpoint.steps['repair:tools:batches']), saved, 'unknown restart preserves accepted decisions and the original pending intent')

})

test('native accepted decisions resume after a known pre-dispatch failure without being reselected', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, turns = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const accepted = patch(), rejected = new TextProviderError('mock failed before provider dispatch', false); rejected.delivery = 'not_sent'
  await assert.rejects(runScriptDraftRepairTools({ ...common(), steps: steps(), turn: async () => {
    if (++turns === 1) return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, edits: [], source_edits: [], complete: false })])
    throw rejected
  } }), error => error === rejected)
  let resumed = 0
  const result = await runScriptDraftRepairTools({ ...common(), steps: steps(), turn: async () => {
    resumed++; return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [], summary: accepted.summary, edits: accepted.edits, source_edits: [], complete: true })])
  } })
  assert.deepEqual(result, accepted); assert.equal(resumed, 1)
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
    if (turns === 3) {
      const result = JSON.parse(outputs![0]!.output).result
      rejected = result.rejected_operations.some((item: any) => item.diagnostic.code === 'overlapping_passages')
      assert.equal(result.accepted_edits, 1, 'the accepted first page survives the rejected overlapping operation')
      throw new Error('overlap verified')
    }
    return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [], summary: accepted.summary,
      edits: [{ ...accepted.edits[0]!, find: '钥匙代价未定', replace: '另一个不兼容的决定' }], source_edits: [], complete: true })])
  } }), /overlap verified/)
  assert.equal(rejected, true)
})

const nativeModel: GenerationModel = { ...model, protocol: 'anthropic_messages', settings: { text_api: { mode: 'standard', output_mode: 'auto' }, stream: false } }
const nativeMessage = (calls: Array<{ id: string; name: string; input: unknown }>, stop_reason = 'tool_use', signed = false) => ({
  type: 'message', role: 'assistant', id: 'native-message', stop_reason,
  content: [...(signed ? [{ type: 'thinking', thinking: 'PRIVATE_NATIVE_THINKING', signature: 'SIGNED_NATIVE_THINKING' }] : []),
    ...calls.map(item => ({ type: 'tool_use', ...item }))], usage: { input_tokens: 12, output_tokens: 5 },
})

test('native repair gate admits Anthropic Messages while preserving disabled and demo boundaries', () => {
  assert.equal(scriptDraftNativeToolsAvailable(nativeModel, provider), true)
  assert.equal(scriptDraftNativeToolsAvailable({ ...nativeModel, settings: { tool_calling: false } }, provider), false)
  assert.equal(scriptDraftNativeToolsAvailable(nativeModel, { ...provider, adapter: 'demo' }), false)
  assert.equal(scriptDraftNativeToolsAvailable({ ...nativeModel, modality: 'image' }, provider), false)
})

test('Anthropic repair uses the actual native session for versioned reads and complete batches with exact signed history', async t => {
  let requests = 0
  const accepted = patch('world'), events: string[] = []
  const firstContent = nativeMessage([{ id: 'wrong-version', name: 'get_repair_context', input: { candidate_version: 'stale', source_keys: ['world'] } }], 'tool_use', true).content
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    requests++; const body = JSON.parse(String(init.body))
    assert.equal(String(url), 'https://test.invalid/v1/messages')
    assert.ok(body.tools.some((tool: any) => tool.name === 'submit_repair_batch' && tool.input_schema))
    assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
    assert.equal(body.output_config?.format, undefined)
    if (requests > 1) assert.deepEqual(body.messages.find((item: any) => item.role === 'assistant'), { role: 'assistant', content: firstContent }, 'authenticated native history remains byte-for-byte intact')
    if (requests === 1) {
      assert.ok(!body.messages[0].content.includes(draft().artifacts[1]!.content), 'unrelated candidate text is read on demand')
      return Response.json(nativeMessage([{ id: 'wrong-version', name: 'get_repair_context', input: { candidate_version: 'stale', source_keys: ['world'] } }], 'tool_use', true))
    }
    const result = body.messages.findLast((item: any) => item.role === 'user' && Array.isArray(item.content)).content[0]
    assert.equal(result.type, 'tool_result')
    if (requests === 2) {
      assert.equal(result.tool_use_id, 'wrong-version'); assert.equal(JSON.parse(result.content).ok, false)
      return Response.json(nativeMessage([{ id: 'read-world', name: 'get_repair_context', input: { candidate_version: 'candidate-v1', source_keys: ['world'] } }]))
    }
    if (requests === 3) {
      assert.equal(result.tool_use_id, 'read-world')
      assert.equal(JSON.parse(result.content).result.documents[0].content, draft().artifacts[1]!.content)
      return Response.json(nativeMessage([{ id: 'decisions', name: 'submit_repair_batch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1',
        decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, source_edits: [], edits: [], complete: false } }]))
    }
    assert.equal(requests, 4, 'successful final submission needs no summary request')
    assert.equal(result.tool_use_id, 'decisions'); assert.equal(JSON.parse(result.content).result.accepted_decisions, 1)
    return Response.json(nativeMessage([{ id: 'finish', name: 'submit_repair_batch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [], summary: accepted.summary, source_edits: [], edits: accepted.edits, complete: true } }]))
  })
  const result = await runScriptDraftRepairTools({ ...common(), model: nativeModel, fallback: async () => assert.fail('native Messages must not enter full-context fallback'),
    onToolEvent: event => events.push(event.status + ':' + event.name) })
  assert.deepEqual(result, accepted); assert.equal(requests, 4)
  assert.ok(events.includes('failed:get_repair_context')); assert.ok(events.includes('succeeded:submit_repair_batch'))
})

test('Anthropic truncated tool submissions never execute or commit history before a complete batch', async t => {
  let requests = 0
  const accepted = patch(), events: string[] = []
  const data = { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }],
    summary: accepted.summary, source_edits: [], edits: accepted.edits, complete: true }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++; const body = JSON.parse(String(init.body))
    if (requests === 1) return Response.json(nativeMessage([{ id: 'must-not-execute', name: 'submit_repair_batch', input: data }], 'max_tokens', true))
    assert.equal(requests, 2)
    assert.equal(body.messages.some((item: any) => item.role === 'assistant'), false, 'a failed native turn never becomes committed history')
    assert.match(body.messages.at(-1).content, /未执行任何残缺工具/)
    return Response.json(nativeMessage([{ id: 'complete', name: 'submit_repair_batch', input: data }]))
  })
  const result = await runScriptDraftRepairTools({ ...common(), model: nativeModel,
    onToolEvent: event => events.push(event.id), fallback: async () => assert.fail('truncation must not switch to fallback') })
  assert.deepEqual(result, accepted); assert.equal(requests, 2)
  assert.ok(events.every(id => !id.includes('must-not-execute')))
})

test('exact structured fallback work resumes across the native gate upgrade and completed tools remain reusable', async t => {
  const { TextOutputLimitError } = await import('../src/infrastructure/providers/text-errors.js')
  const accepted = patch(), fallbackPrompt = common().prompt
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  await assert.rejects(generateScriptDraftRepairOutput(fallbackPrompt, ['issue-1'], async (_sent, contract) => {
    if (contract!.name === 'script_draft_repair') throw new TextOutputLimitError('', 'length')
    if (contract!.name === 'script_draft_repair_decisions') return JSON.stringify({ decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }] })
    // This stub stops before any edits provider dispatch, so non-acceptance is known.
    const stop = new TextProviderError('offline_stop_after_completed_decisions', false); stop.delivery = 'not_sent'; throw stop
  }, { steps: steps() }), /offline_stop_after_completed_decisions/)
  const oldDecision = structuredClone(checkpoint.steps['repair:decisions'])
  assert.equal(hasScriptDraftRepairCheckpoint(fallbackPrompt, ['issue-1'], steps()), true)
  assert.equal(hasScriptDraftRepairCheckpoint(fallbackPrompt + 'changed', ['issue-1'], steps()), false)
  assert.equal(hasScriptDraftRepairCheckpoint(fallbackPrompt, ['other-issue'], steps()), false)
  assert.equal(hasScriptDraftRepairCheckpoint(fallbackPrompt, ['issue-1'], steps(), { unit: 'seconds', estimated_total: 60 }), false)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('exact saved fallback decisions must not restart as a native session'))
  const currentSteps = steps()
  const result = await runScriptDraftRepairTools({ ...common(), model: nativeModel, steps: currentSteps,
    resumeFallback: hasScriptDraftRepairCheckpoint(fallbackPrompt, ['issue-1'], currentSteps),
    fallback: () => generateScriptDraftRepairOutput(fallbackPrompt, ['issue-1'], async (_sent, contract) => {
      calls++; assert.equal(contract!.name, 'script_draft_repair_edits')
      return JSON.stringify({ summary: accepted.summary, source_edits: [], edits: accepted.edits })
    }, { steps: currentSteps }) })
  assert.deepEqual(result, accepted); assert.equal(calls, 1); assert.deepEqual(checkpoint.steps['repair:decisions'], oldDecision)
  const completed = structuredClone(checkpoint.steps['repair:edits'])
  // Even if the outer tools aggregate was not yet saved before a restart, the
  // exact structured child still returns without another native/model call.
  delete checkpoint.steps['repair:tools']
  const resumed = steps()
  await runScriptDraftRepairTools({ ...common(), model: nativeModel, steps: resumed,
    resumeFallback: hasScriptDraftRepairCheckpoint(fallbackPrompt, ['issue-1'], resumed),
    fallback: () => generateScriptDraftRepairOutput(fallbackPrompt, ['issue-1'], async () => assert.fail('completed edits must remain reused'), { steps: resumed }) })
  assert.deepEqual(checkpoint.steps['repair:edits'], completed)
  await runScriptDraftRepairTools({ ...common(), model: nativeModel, steps: steps(), resumeFallback: false,
    fallback: async () => assert.fail('completed repair:tools must replay without entering either protocol') })
})

// Exercise the actual native transport: tool availability changes only at a
// decision boundary; signed assistant blocks and their full results survive.
test('all candidate reads move native repair into submission-only decisions with exact evidence and progress', async t => {
  const accepted = patch('world'), input = common()
  let requests = 0
  const read = { id: 'all-remaining', name: 'get_repair_context', input: { candidate_version: 'candidate-v1', source_keys: ['world', 'constraints'] } }
  const signedRead = nativeMessage([read], 'tool_use', true).content
  const toolNames = (body: any) => body.tools.map((item: any) => item.name)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests++
    const current = JSON.parse(body.messages.at(-1).content)
    assert.equal(current.repair_progress.loaded_documents, requests === 1 ? 1 : 3)
    assert.equal(body.tool_choice.type, 'auto', 'thinking-compatible tool selection remains automatic')
    if (requests === 1) {
      assert.deepEqual(toolNames(body), ['get_repair_context', 'search_repair_context', 'submit_repair_batch', 'submit_repair_patch'])
      assert.deepEqual(current.repair_progress.unread_source_keys, ['world', 'constraints'])
      assert.ok(body.messages[0].content.indexOf('只读候选工作区') < body.messages[0].content.indexOf(input.prompt), 'the actual candidate precedes base skills and full reference material')
      return Response.json(nativeMessage([read], 'tool_use', true))
    }
    assert.deepEqual(toolNames(body), ['submit_repair_batch', 'submit_repair_patch'])
    assert.deepEqual(body.messages.find((item: any) => item.role === 'assistant'), { role: 'assistant', content: signedRead })
    assert.deepEqual(current.repair_progress.unread_source_keys, [])
    const result = body.messages.find((item: any) => item.role === 'user' && Array.isArray(item.content)).content[0]
    assert.equal(result.tool_use_id, read.id)
    const documents = JSON.parse(result.content).result.documents
    assert.deepEqual(documents.map((item: any) => [item.source_key, item.content]), draft().artifacts.slice(1).map(item => [item.artifact_type, item.content]))
    if (requests === 2) {
      assert.deepEqual(current.repair_progress.remaining_issue_ids, ['issue-1'])
      return Response.json(nativeMessage([{ id: 'decisions', name: 'submit_repair_batch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1',
        decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, source_edits: [], edits: [], complete: false } }]))
    }
    assert.equal(requests, 3)
    assert.deepEqual(current.repair_progress.accepted_issue_ids, ['issue-1'])
    assert.deepEqual(current.repair_progress.remaining_issue_ids, [])
    return Response.json(nativeMessage([{ id: 'finish', name: 'submit_repair_batch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [], summary: accepted.summary, source_edits: [], edits: accepted.edits, complete: true } }]))
  })
  assert.deepEqual(await runScriptDraftRepairTools({ ...input, model: nativeModel }), accepted)
  assert.equal(requests, 3)
})

test('initially complete candidate exposes only submissions and rejects hallucinated historical searches without rereading', async t => {
  const candidate = workspace({ findings: [{ ...finding, source_key: 'global' }] })
  const reads = candidate.loadedSources(), accepted = patch()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); requests++
    assert.deepEqual(body.tools.map((item: any) => item.name), ['submit_repair_batch', 'submit_repair_patch'])
    const current = JSON.parse(body.messages.at(-1).content)
    assert.equal(current.repair_progress.loaded_documents, 3)
    if (requests === 1) return Response.json(nativeMessage([{ id: 'obsolete-search', name: 'search_repair_context', input: { candidate_version: 'candidate-v1', query: '铜钥匙', source_keys: [] } }], 'tool_use', true))
    assert.equal(requests, 2)
    const output = body.messages.findLast((item: any) => item.role === 'user' && Array.isArray(item.content)).content[0]
    const diagnostic = JSON.parse(output.content)
    assert.equal(diagnostic.ok, false)
    assert.equal(diagnostic.diagnostic.code, 'repair_tool_unavailable')
    assert.deepEqual(candidate.loadedSources(), reads)
    return Response.json(nativeMessage([{ id: 'finish', name: 'submit_repair_patch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1', ...accepted } }]))
  })
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), workspace: candidate, model: nativeModel }), accepted)
  assert.equal(requests, 2)
})

test('pre-phase successful tools and retained native batches keep their exact historical input identities', async () => {
  const input = common(), accepted = patch()
  const checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = createGenerationSteps({ checkpoint })
  const oldInput = { strategy: 'candidate-tools-v1', prompt: input.prompt, workspace: input.workspace.identity, issue_ids: input.issueIds,
    model: input.model, provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }
  steps.retain('repair:tools', 'historical success', oldInput, accepted, value => value)
  const oldSuccess = structuredClone(steps.checkpoint.steps['repair:tools'])
  assert.deepEqual(await runScriptDraftRepairTools({ ...input, steps, turn: async () => assert.fail('historical success must not call the model') }), accepted)
  assert.deepEqual(steps.checkpoint.steps['repair:tools'], oldSuccess)
  steps.forget('repair:tools')
  const oldBatchInput = { version: 1, identity: { prompt: input.prompt, workspace: input.workspace.identity, model: input.model,
    provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }, issue_ids: input.issueIds }
  steps.retain('repair:tools:batches', 'historical batch', oldBatchInput,
    { decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, edits: accepted.edits, source_edits: [] }, value => value)
  const oldBatchHash = steps.checkpoint.steps['repair:tools:batches']!.input_hash
  let requests = 0
  const result = await runScriptDraftRepairTools({ ...input, steps, turn: async (_outputs, continuation) => {
    requests++
    const progress = JSON.parse(continuation!).repair_progress
    assert.deepEqual(progress.accepted_issue_ids, ['issue-1'])
    assert.equal(progress.accepted_edits, 1)
    return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [],
      summary: accepted.summary, edits: [], source_edits: [], complete: true })])
  } })
  assert.deepEqual(result, accepted)
  assert.equal(requests, 1)
  assert.equal(steps.checkpoint.steps['repair:tools:batches']!.input_hash, oldBatchHash)
})

test('actual pre-paragraph native identity reuses complete success with no provider call', async () => {
  const input = common(), accepted = patch(), steps = createGenerationSteps()
  assert.notEqual(input.workspace.identity, input.workspace.legacyIdentity)
  const historical = { strategy: 'candidate-tools-v1', prompt: input.prompt, workspace: input.workspace.legacyIdentity, issue_ids: input.issueIds,
    model: input.model, provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }
  steps.retain('repair:tools', 'actual old whole success', historical, accepted, value => value)
  const before = structuredClone(steps.checkpoint.steps['repair:tools'])
  assert.deepEqual(await runScriptDraftRepairTools({ ...input, steps, turn: async () => assert.fail('exact old success must not dispatch') }), accepted)
  assert.deepEqual(steps.checkpoint.steps['repair:tools'], before, 'successful historical identity is not rewritten')
})

test('seven historical native successes survive migration beside the old exact batch identity', async () => {
  const candidate: WorkflowDraft = { stage: 'episode', scope: 'episode', episode_number: 1,
    artifacts: [{ artifact_type: 'episode_script', title: '第一集', content: '完整正文。' }],
    scenes: Array.from({ length: 7 }, (_, index) => ({ heading: `第${index + 1}场`, location: '车站', time_of_day: '夜', characters: '林晚', action: `已确认第${index + 1}段。`, dialogue: '', narration: '', duration: 5 })) }
  const context = workspace({ draft: candidate, findings: [{ ...finding, source_key: 'global' }] }), input = { ...common(), workspace: context }, steps = createGenerationSteps()
  const edits = candidate.scenes.map((scene, index) => ({ source_key: `scene:${index}:action`, find: scene.action, replace: scene.action + '保留的已确认修订。', reason: '落实已确认决定' }))
  const historical = { version: 1, identity: { prompt: input.prompt, workspace: context.legacyIdentity, model: input.model, provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }, issue_ids: input.issueIds }
  steps.retain('repair:tools:batches', 'seven historical successes', historical, { decisions: [{ issue_id: 'issue-1', decision: patch().decisions[0] }], summary: '保留七份成功', source_edits: [], edits }, value => value)
  const old = structuredClone(steps.checkpoint.steps['repair:tools:batches']); let calls = 0
  const result = await runScriptDraftRepairTools({ ...input, steps, turn: async (_outputs, continuation) => {
    calls++; assert.equal(JSON.parse(continuation!).repair_progress.accepted_edits, 7)
    return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [], summary: '保留七份成功', edits: [], source_edits: [], complete: true })])
  } })
  assert.equal(calls, 1); assert.deepEqual(result.edits, edits)
  assert.deepEqual(steps.checkpoint.steps['repair:tools:batches'], old)
  assert.ok(steps.checkpoint.steps['repair:tools:operations'], 'new operation/intent state does not overwrite the old checkpoint')
})

test('only a local empty-ledger no-progress guard selects exact persistent workset recovery', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, turns = 0, recovered = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const accepted = patch()
  const options = { ...common(), steps: steps(), turn: async () => { turns++; return response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['outline'] })]) },
    recoverStalled: async () => { recovered++; throw new Error('workset interrupted') } }
  await assert.rejects(runScriptDraftRepairTools(options), /workset interrupted/)
  assert.equal(turns, 2); assert.equal(recovered, 1)
  assert.equal(checkpoint.steps['repair:tools:worksets']?.value, 'per-document-v1')
  const before = turns
  assert.deepEqual(await runScriptDraftRepairTools({ ...options, steps: steps(), recoverStalled: async () => { recovered++; return accepted } }), accepted)
  assert.equal(turns, before, 'exact recovery marker skips a stalled native path')
  const marker = structuredClone(checkpoint.steps['repair:tools:worksets'])
  delete checkpoint.steps['repair:tools']
  await assert.rejects(runScriptDraftRepairTools({ ...options, model: { ...model, remote_id: 'changed' }, steps: steps(), turn: async () => { turns++; throw new Error('new native model') } }), /new native model/)
  assert.deepEqual(checkpoint.steps['repair:tools:worksets'], marker)
})

test('provider failures, unknown delivery, cancellation, generic 422 and decision-only batches never trigger workset recovery', async () => {
  const unknownLimit = new TextToolOutputLimitError('length'); unknownLimit.delivery = 'unknown'
  const providerStalled = Object.assign(new TextProviderError('same text', false), { code: 'script_draft_repair_stalled' })
  const failures = [unknownLimit, providerStalled, Object.assign(new Error('conflict'), { statusCode: 409 }), Object.assign(new Error('generic invalid'), { statusCode: 422 }),
    new TextProviderError('unauthorized', false, 'invalid_api_key', 401)]
  for (const failure of failures) {
    let recovered = 0, turns = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(), turn: async () => { turns++; throw failure }, recoverStalled: async () => { recovered++; return patch() } }), error => error === failure)
    assert.equal(recovered, 0); assert.equal(turns, 1)
  }
  let turns = 0, recovered = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), turn: async () => {
    if (++turns === 1) return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1',
      decisions: [{ issue_id: 'issue-1', decision: patch().decisions[0] }], summary: '保留决定', edits: [], source_edits: [], complete: false })])
    return response([], 'still reading')
  }, recoverStalled: async () => { recovered++; return patch() } }), (error: any) => error.code === 'script_draft_repair_stalled')
  assert.equal(recovered, 0)
  const controller = new AbortController()
  await assert.rejects(runScriptDraftRepairTools({ ...common(), signal: controller.signal, turn: async () => { controller.abort(new Error('creator cancelled')); return response([], '') },
    recoverStalled: async () => assert.fail('cancelled guard must not recover') }), /creator cancelled/)
})

test('business-validator errors cannot become a local stalled recovery through diagnostic wording', async () => {
  const failure = Object.assign(new Error('完整提交业务校验不可用'), { statusCode: 422 })
  let recovered = 0, turns = 0
  await assert.rejects(runScriptDraftRepairTools({ ...common(), turn: async () => { turns++; return response([submitted()]) }, validate: () => { throw failure },
    recoverStalled: async () => { recovered++; return patch() } }), error => error === failure)
  assert.equal(turns, 1); assert.equal(recovered, 0)
})

test('an exact workset marker wins unfinished fallback hints, accepted native batches win the marker, and success wins all recovery', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, recovered = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const input = common(), accepted = patch()
  await assert.rejects(runScriptDraftRepairTools({ ...input, steps: steps(), turn: async () => response([call('get_repair_context', { candidate_version: 'candidate-v1', source_keys: ['outline'] })]),
    recoverStalled: async () => { throw new Error('workset paused') } }), /workset paused/)
  const exactMarker = structuredClone(checkpoint.steps['repair:tools:worksets'])
  await assert.rejects(runScriptDraftRepairTools({ ...common(), steps: steps(), resumeFallback: true,
    turn: async () => assert.fail('exact marker must not repeat native'), fallback: async () => assert.fail('exact marker must not return to a legacy hint'),
    recoverStalled: async () => { recovered++; throw new Error('workset resumed') } }), /workset resumed/)
  assert.equal(recovered, 1)
  const seeded = steps()
  seeded.retain('repair:tools:batches', 'historical decision batch', { version: 1, identity: { prompt: input.prompt, workspace: input.workspace.identity, model: input.model,
    provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }, issue_ids: input.issueIds },
    { decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, edits: [], source_edits: [] }, value => value)
  let turns = 0
  const result = await runScriptDraftRepairTools({ ...common(), steps: steps(), resumeFallback: true,
    fallback: async () => assert.fail('native batch must not be lost to legacy'), recoverStalled: async () => assert.fail('native batch must not be lost to worksets'),
    turn: async () => { turns++; return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [],
      summary: accepted.summary, edits: accepted.edits, source_edits: [], complete: true })]) } })
  assert.deepEqual(result, accepted); assert.equal(turns, 1)
  assert.deepEqual(checkpoint.steps['repair:tools:worksets'], exactMarker)
  await runScriptDraftRepairTools({ ...common(), steps: steps(), resumeFallback: true,
    turn: async () => assert.fail('whole success must replay'), fallback: async () => assert.fail('whole success must replay'),
    recoverStalled: async () => assert.fail('whole success must replay') })
})

test('authoritative manual recovery supports 4000 characters without broadening native or AI schemas and replays exact success', async () => {
  const plan = '作者方案：' + '丁'.repeat(3995)
  const accepted = { ...patch(), decisions: [plan] }
  let checkpoint: GenerationCheckpoint = { steps: {} }, turns = 0, recoveries = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const result = await runScriptDraftRepairTools({ ...common(), manualPlans: [plan], steps: steps(),
    turn: async () => { turns++; return response([], '无有效提交') }, recoverStalled: async () => { recoveries++; return accepted } })
  assert.deepEqual(result, accepted); assert.equal(turns, 0); assert.equal(recoveries, 1)
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: [plan], steps: steps(), turn: async () => assert.fail('exact whole success must replay'),
    recoverStalled: async () => assert.fail('exact whole success must replay') }), accepted)
  for (const wrong of [plan.slice(0, 100), plan + '改写', '换成另一份决定']) {
    const damaged = structuredClone(checkpoint)
    ;(damaged.steps['repair:tools']!.value as any).decisions = [wrong]
    const invalidSteps = createGenerationSteps({ checkpoint: damaged })
    let native = 0, recovered = 0
    await runScriptDraftRepairTools({ ...common(), manualPlans: [plan], steps: invalidSteps, turn: async () => { native++; return response([], '') },
      recoverStalled: async () => { recovered++; return accepted } })
    assert.equal(native, 0); assert.equal(recovered, 1, 'changed manual content must invalidate even a plausible shorter cached decision')
  }
  await assert.rejects(runScriptDraftRepairTools({ ...common(), manualPlans: [plan], turn: async () => response([], ''), recoverStalled: async () => ({ ...accepted, decisions: ['缩短重述'] }) }))
  const { createScriptDraftRepairOutputSchema } = await import('../src/modules/script/script-draft-repair-generation.js')
  assert.equal(createScriptDraftRepairOutputSchema(['issue-1']).safeParse(accepted).success, false, 'normal AI/native output still caps decisions at 2000')
})

test('manual authority is never embedded into ordinary native tool schemas', async t => {
  const plan = '权威作者方案。' + '戊'.repeat(2800)
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const tools = JSON.stringify(body.tools)
    assert.ok(!tools.includes(plan)); assert.ok(!tools.includes('具体决定必须逐项完整沿用'))
    assert.ok(tools.includes('"maxLength":2000'))
    assert.ok(!tools.includes('"maxLength":4000'))
    return Response.json(nativeMessage([{ id: 'native-finish', name: 'submit_repair_patch', input: { candidate_version: 'candidate-v1', source_version: 'source-v1', ...patch() } }]))
  })
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), model: nativeModel, manualPlans: [plan] }), patch())
})


test('fresh strict manual plans select exact persistent worksets without a native decision request', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, recovered = 0
  const input = common(), accepted = patch(), before = structuredClone(input.workspace.initial)
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const result = await runScriptDraftRepairTools({ ...input, manualPlans: accepted.decisions, steps: steps(),
    turn: async () => assert.fail('explicit manual plans need no native read/search/model decision'),
    recoverStalled: async () => { recovered++; return accepted } })
  assert.deepEqual(result, accepted); assert.equal(recovered, 1)
  assert.equal(checkpoint.steps['repair:tools:worksets']?.value, 'per-document-v1')
  assert.deepEqual(input.workspace.initial, before, 'selection does not mutate candidate bodies or introduce read receipts')
  await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, steps: steps(),
    turn: async () => assert.fail('exact completed manual result must replay'), recoverStalled: async () => assert.fail('exact completed manual result must replay') })
  for (const invalid of [[], [''], ['甲'.repeat(4001)]]) await assert.rejects(runScriptDraftRepairTools({ ...common(), manualPlans: invalid,
    turn: async () => assert.fail('invalid author plans never dispatch'), recoverStalled: async () => assert.fail('invalid author plans never select worksets') }))
})

test('manual direct worksets retain historical whole success, accepted native decisions and proven legacy fallback priority', async () => {
  const input = common(), accepted = patch()
  const nativeInput = { strategy: 'candidate-tools-v1', prompt: input.prompt, workspace: input.workspace.identity, issue_ids: input.issueIds,
    model: input.model, provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }
  const completed = createGenerationSteps()
  completed.retain('repair:tools', 'historical native success', nativeInput, accepted, value => value)
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, steps: completed,
    turn: async () => assert.fail('old native success wins'), recoverStalled: async () => assert.fail('old native success wins') }), accepted)
  const batch = createGenerationSteps()
  batch.retain('repair:tools:batches', 'historical decision-only batch', { version: 1, identity: { prompt: input.prompt, workspace: input.workspace.identity, model: input.model,
    provider: { adapter: input.provider.adapter, base_url: input.provider.base_url } }, issue_ids: input.issueIds },
    { decisions: [{ issue_id: 'issue-1', decision: accepted.decisions[0] }], summary: accepted.summary, edits: [], source_edits: [] }, value => value)
  let turns = 0
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, steps: batch, resumeFallback: true,
    fallback: async () => assert.fail('even a decision-only batch keeps native ownership'), recoverStalled: async () => assert.fail('even a decision-only batch keeps native ownership'),
    turn: async () => { turns++; return response([call('submit_repair_batch', { candidate_version: 'candidate-v1', source_version: 'source-v1', decisions: [],
      summary: accepted.summary, edits: accepted.edits, source_edits: [], complete: true })]) } }), accepted)
  assert.equal(turns, 1)
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, resumeFallback: true,
    fallback: async () => accepted, turn: async () => assert.fail('proven existing fallback wins fresh manual selection'),
    recoverStalled: async () => assert.fail('proven existing fallback wins fresh manual selection') }), accepted)
})

test('manual marker resumes before a legacy hint and input/configuration changes bind a fresh exact marker', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, recoveries = 0
  const accepted = patch(), steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const first = { ...common(), manualPlans: accepted.decisions, steps: steps(), turn: async () => assert.fail('manual never spins native'),
    recoverStalled: async () => { throw new Error('workset paused') } }
  await assert.rejects(runScriptDraftRepairTools(first), /workset paused/)
  const initialHash = checkpoint.steps['repair:tools:worksets']!.input_hash
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, steps: steps(), resumeFallback: true,
    fallback: async () => assert.fail('exact marker wins legacy hint'), turn: async () => assert.fail('exact marker wins native'),
    recoverStalled: async () => { recoveries++; return accepted } }), accepted)
  const changedPlan = '保留身份，使用钥匙失去昨天记忆。'
  const changed = { ...accepted, decisions: [changedPlan] }
  await runScriptDraftRepairTools({ ...common(), prompt: common().prompt + '\n用户完整方案：' + changedPlan,
    manualPlans: [changedPlan], steps: steps(), turn: async () => assert.fail('changed manual input starts worksets directly'),
    recoverStalled: async () => { recoveries++; return changed } })
  assert.notEqual(checkpoint.steps['repair:tools:worksets']!.input_hash, initialHash)
  const changedHash = checkpoint.steps['repair:tools:worksets']!.input_hash
  await runScriptDraftRepairTools({ ...common(), model: { ...model, remote_id: 'different-configured-model' }, manualPlans: accepted.decisions, steps: steps(),
    turn: async () => assert.fail('changed configuration starts a new exact manual workset'), recoverStalled: async () => { recoveries++; return accepted } })
  assert.notEqual(checkpoint.steps['repair:tools:worksets']!.input_hash, changedHash); assert.equal(recoveries, 3)
})

test('manual plans changed without prompt changes cannot reuse a different cached authoritative result', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const accepted = patch(), steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  await runScriptDraftRepairTools({ ...common(), manualPlans: accepted.decisions, steps: steps(), recoverStalled: async () => accepted })
  const changed = { ...accepted, decisions: ['另一份完整作者方案，不得重述。'] }
  let recovered = 0
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), manualPlans: changed.decisions, steps: steps(), turn: async () => assert.fail('stale authority must not reenter native'),
    recoverStalled: async () => { recovered++; return changed } }), changed)
  assert.equal(recovered, 1)
})

test('manual workset caller conflict and unknown propagate once without native or generic fallback', async () => {
  const unknown = new TextProviderError('accepted without terminal', true, 'connection_error'); unknown.delivery = 'unknown'
  for (const failure of [Object.assign(new Error('candidate changed'), { statusCode: 409 }), unknown]) {
    let recovered = 0
    await assert.rejects(runScriptDraftRepairTools({ ...common(), manualPlans: patch().decisions,
      turn: async () => assert.fail('manual failed worksets never return to native'), fallback: async () => assert.fail('manual failed worksets never become generic fallback'),
      recoverStalled: async () => { recovered++; throw failure } }), error => error === failure)
    assert.equal(recovered, 1)
  }
  let turns = 0
  assert.deepEqual(await runScriptDraftRepairTools({ ...common(), turn: async () => { turns++; return response([submitted()]) },
    recoverStalled: async () => assert.fail('AI strategy keeps its native flow') }), patch())
  assert.equal(turns, 1)
})

}
