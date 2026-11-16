import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test, mock } from 'node:test'
import { z } from 'zod'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { beginTextRequest, createScriptRequestUsage, TextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { ReviewPaginationStalledError } from '../src/modules/script/script-review-pagination.js'
import { modelAttemptNumber } from '../src/modules/generation/model-execution.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import { createGenerationSteps, type GenerationCheckpoint, type GenerationStepEvent } from '../src/modules/script/script-generation-steps.js'

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
const { createScriptDraftRepairOutputSchema, createScriptDraftRepairDecisionsSchema, generateScriptDraftRepairOutput } =
  await import('../src/modules/script/script-draft-repair-generation.js')
const { generateStructuredOutput, outputContract } = await import('../src/modules/generation/model-output.js')
const { createDraftRepairReferences } = await import('../src/modules/script/script-draft-repair-references.js')
const { repairScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')

const ids = Array.from({ length: 9 }, (_, index) => `issue-${index}`)
const decisions = ids.map((issue_id, index) => ({ issue_id, decision: `第${index}项采用用户已授权的具体决定` }))
const edits = () => ({ summary: '已经同步全部决定', source_edits: [],
  edits: [{ source_key: 'world', find: '候选稿原文', replace: '落实具体决定的候选稿', reason: '同步已授权决定' }] })
const whole = () => ({ ...edits(), decisions: decisions.map(item => item.decision) })
const text = (value: unknown) => JSON.stringify(value)
const outputLimit = (partialText = '') => new TextOutputLimitError(partialText, 'length')
const prompt = '用户已授权完整创作要求：保持十七个位置与既定结局。\n当前有效稿：' + '完整原文与因果。'.repeat(200) +
  '\n完整原稿结尾。\n全部候选文档：' + ids.map(id => `${id}文档开头\n${id}完整正文\n${id}文档结尾`).join('\n')
const stage = (contract?: OutputContract) => contract!.name.replace('script_draft_repair', '') || 'whole'
function fixture() {
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const events: GenerationStepEvent[] = []
  return {
    events,
    checkpoint: () => structuredClone(checkpoint),
    save: (value: GenerationCheckpoint) => { checkpoint = structuredClone(value) },
    steps(signal?: AbortSignal) {
      return createGenerationSteps({ checkpoint, signal, save: value => { checkpoint = structuredClone(value) }, onStep: event => events.push(event) })
    },
  }
}
const has = (checkpoint: GenerationCheckpoint, id: string) => Object.hasOwn(checkpoint.steps, id)
function assertFullContext(sent: string) {
  assert.ok(sent.includes(prompt), 'every request retains the original complete source and all candidate documents')
  assert.ok(sent.includes(`本次问题身份：${JSON.stringify(ids)}`))
}

const referencedDocuments = (sent: string) => JSON.parse(sent.slice(sent.lastIndexOf('可替换来源（冻结段落原文）：') + '可替换来源（冻结段落原文）：'.length).split('\n')[0]!) as
  Array<{ source_key: string; parts: Array<string | [string, string]> }>

const partText = (part: string | [string, string]) => typeof part === 'string' ? part : part[1]
const referencePart = (parts: Array<string | [string, string]>, matches: (value: string) => boolean = () => true) =>
  parts.find((part): part is [string, string] => Array.isArray(part) && matches(part[1]))!

test('frozen references bind unique current paragraphs and preserve whitespace, Unicode and exact-edit atomicity', () => {
  const content = '重复原段。\r\n\r\n规则六：无瓶颈😀，熟练度满自动突破。\r\n保留这一行。\n\n重复原段。\n'
  const sources = [{ key: 'world', title: '背景', content }, { key: 'constraints', title: '禁区', content: '保留原规则。' }]
  const original = `技能全文与用户原话不能删。\n可替换来源：${text(sources)}`
  const identity = { candidate_id: 'candidate', candidate_version: 'candidate-v1', source_version: 'source-v1' }
  const references = createDraftRepairReferences(sources, identity), sent = references.prompt(original), documents = referencedDocuments(sent)
  assert.ok(sent.startsWith('技能全文与用户原话不能删。'))
  assert.deepEqual(documents.map(document => document.parts.map(partText).join('')), sources.map(source => source.content))
  assert.equal(sent.includes('重复原段。'), true)
  const repeated = documents[0]!.parts.filter((part): part is [string, string] => Array.isArray(part) && part[1] === '重复原段。')
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0]![0], repeated[1]![0], 'identical text at different frozen positions has separate identities')
  const paragraph = referencePart(documents[0]!.parts, value => value.startsWith('规则六'))
  const replacement = paragraph[1].replace('无瓶颈😀', '保持无瓶颈😀')
  const wire = { operation: 'replace_ref', source_key: 'world', ref_id: paragraph[0], replace: replacement, reason: '落实原稿规则' }
  const normalized = references.editSchema.parse(wire)
  assert.ok('paragraph_id' in normalized && !('find' in normalized))
  const [resolved] = references.resolveEdits('world', [normalized]); assert.equal(resolved!.find, paragraph[1]); assert.equal(resolved!.replace, replacement)
  assert.equal(references.editSchema.safeParse({ ...wire, find: paragraph[1] }).success, false, 'ref and find branches are strictly exclusive')
  assert.equal(references.editSchema.safeParse({ ...wire, source_key: 'constraints' }).success, false)
  assert.equal(references.editSchema.safeParse({ ...wire, ref_id: 'r:' + '0'.repeat(24) }).success, false)
  const changedReferences = createDraftRepairReferences([{ ...sources[0]!, content: content + '当前版本新增。' }])
  assert.equal(changedReferences.editSchema.safeParse(wire).success, false, 'a stale ref never remaps to a similar current paragraph')
  assert.equal(createDraftRepairReferences(sources, { ...identity, candidate_version: 'candidate-v2' }).editSchema.safeParse(wire).success, false)
  assert.equal(createDraftRepairReferences(sources, { ...identity, source_version: 'source-v2' }).editSchema.safeParse(wire).success, false)
  sources[0]!.content = '外部变量随后变更。'
  assert.equal(references.resolveEdits('world', [references.editSchema.parse(wire)])[0]!.find, paragraph[1], 'the registry owns its immutable snapshot')
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', scope: 'project', episode_number: 0, intent: 'stage_design', artifact_types: ['world'],
    artifacts: [{ artifact_type: 'world', title: '背景', content }], scenes: [] })
  const pending = { id: 'candidate', version: identity.candidate_version, draft, findings: [], request: {}, source_version: 'source-v1' }
  const before = structuredClone(pending)
  // Workflow normalization trims artifact boundaries; bind IDs to the exact
  // normalized candidate that final adoption actually owns.
  assert.throws(() => repairScriptDraft(pending, [normalized]), /冻结版本/)
  const draftReferences = createDraftRepairReferences([{ key: 'world', content: draft.artifacts[0]!.content }], identity)
  const draftRef = referencePart(draftReferences.documents[0]!.parts, value => value.startsWith('规则六'))[0]
  const normalizedForDraft = draftReferences.editSchema.parse({ ...wire, ref_id: draftRef })
  const repaired = repairScriptDraft(pending, [normalizedForDraft])
  assert.equal(repaired.artifacts[0]!.content, draft.artifacts[0]!.content.replace(paragraph[1], replacement))
  assert.deepEqual(pending, before)
  assert.throws(() => repairScriptDraft(pending, [normalizedForDraft, { source_key: 'world', find: '规则六', replace: '另一段重叠修改', reason: '不能重复同范围' }]), /重叠/)
  assert.deepEqual(pending, before, 'a later invalid operation never leaves an earlier patch applied')
})

test('reference wire and local parse keep the exact ref/find formats mutually exclusive', () => {
  const references = createDraftRepairReferences([{ key: 'world', content: '冻结原文。' }])
  const ref = referencePart(referencedDocuments(references.prompt('完整任务'))[0]!.parts)[0]
  const schema = z.object({ edits: z.array(references.editSchema) }).strict()
  const wire = outputContract('repair_reference_contract', schema).schema as any
  const [byRef, byParagraph, byFind] = wire.properties.edits.items.anyOf
  assert.deepEqual(byRef.required, ['operation', 'source_key', 'ref_id', 'replace', 'reason'])
  assert.deepEqual(byFind.required, ['source_key', 'find', 'replace', 'reason'])
  assert.deepEqual(byParagraph.required, ['source_key', 'paragraph_id', 'replace', 'reason'])
  assert.equal(byRef.additionalProperties, false); assert.equal(byFind.additionalProperties, false)
  assert.equal(byRef.properties.operation.const, 'replace_ref')
  assert.equal(byRef.properties.ref_id.pattern, '^r:[a-f0-9]{24}$')
  assert.equal(byRef.properties.find, undefined)
  assert.equal(byFind.properties.operation, undefined); assert.equal(byFind.properties.ref_id, undefined)
  const validRef = { operation: 'replace_ref', source_key: 'world', ref_id: ref, replace: '修订原文。', reason: '同步决定' }
  const validFind = { source_key: 'world', find: '冻结原文。', replace: '修订原文。', reason: '同步决定' }
  assert.equal(schema.safeParse({ edits: [validRef, validFind] }).success, true)
  for (const invalid of [{ ...validRef, find: validFind.find }, { ...validFind, operation: 'replace_ref' },
    { ...validRef, operation: undefined }, { ...validRef, ref_id: undefined }]) {
    assert.equal(schema.safeParse({ edits: [invalid] }).success, false)
  }
})

test('reference union corrections name actual missing, mixed and wrong-type fields without another retry', async t => {
  const references = createDraftRepairReferences([{ key: 'world', content: '冻结原文。' }])
  const ref = referencePart(referencedDocuments(references.prompt('完整任务'))[0]!.parts)[0]
  const schema = z.object({ edits: z.array(references.editSchema) }).strict()
  const valid = { operation: 'replace_ref', source_key: 'world', ref_id: ref, replace: '修订原文。', reason: '同步决定' }
  const cases = [
    { label: 'missing reason', invalid: { ...valid, reason: undefined }, match: /\$\.edits\[0\]\.reason: 缺少必填字段/, absent: /\.find|允许格式/ },
    { label: 'mixed find', invalid: { ...valid, find: '冻结原文。' }, match: /\$\.edits\[0\]\.find: .*请删除该字段/, absent: /\.ref_id: .*删除|\.operation: .*删除|允许格式/ },
    { label: 'missing operation', invalid: { ...valid, operation: undefined }, match: /\$\.edits\[0\]\.operation: 缺少必填字段/, absent: /\.find|允许格式/ },
    { label: 'wrong value types', invalid: { ...valid, ref_id: 7, replace: ['修订原文。'] }, match: /\$\.edits\[0\]\.ref_id: .*要求 string.*number/, absent: /\.find|允许格式/ },
  ]
  for (const fixture of cases) await t.test(fixture.label, async () => {
    let calls = 0, diagnostics = ''
    const result = await generateStructuredOutput('repair_reference_contract', schema, async () => JSON.stringify({ edits: [++calls === 1 ? fixture.invalid : valid] }),
      '原任务全文保持不变', { onAttempt: (_attempt, value) => { if (value) diagnostics = value } })
    assert.equal(calls, 2, 'the existing single correction is unchanged')
    assert.match(diagnostics, fixture.match); assert.doesNotMatch(diagnostics, fixture.absent)
    assert.equal(references.resolveEdits('world', result.edits)[0]!.find, '冻结原文。')
    if (fixture.label === 'wrong value types') assert.match(diagnostics, /\$\.edits\[0\]\.replace: .*要求 string.*array/)
  })
  let calls = 0
  await assert.rejects(generateStructuredOutput('repair_reference_contract', schema, async () => {
    calls++; return JSON.stringify({ edits: [{ ...valid, operation: 'replace' }] })
  }, '原任务全文保持不变'), issue => {
    assert.match((issue as Error).message, /\$\.edits\[0\]\.operation: 字段取值不合法.*replace_ref/)
    return true
  })
  assert.equal(calls, 2, 'an illegal action still fails closed after the same one correction')
})

test('a quote-failed recovery reuses its exact old decisions and edits only through the new frozen-reference contract', async () => {
  const f = fixture(), sources = [{ key: 'world', title: '背景', content: '规则一：已给事实。\n\n规则六：熟练度满自动突破😀。\n\n其他原文原样保留。' }]
  const original = `技能合成例与当前原稿完整保留。\n可替换来源：${text(sources)}`
  const validate = (value: ReturnType<typeof whole>) => {
    const references = createDraftRepairReferences(sources)
    for (const edit of value.edits) {
      if ('paragraph_id' in edit) assert.equal(references.resolveEdits('world', [edit]).length, 1)
      else assert.ok(sources[0]!.content.includes(edit.find!), 'all normalized quotations still pass exact current-text validation')
    }
  }
  await assert.rejects(generateScriptDraftRepairOutput(original, ids, async (_sent, contract) => {
    if (stage(contract) === 'whole') throw outputLimit()
    if (stage(contract) === '_decisions') return text({ decisions })
    return text({ ...edits(), edits: [{ ...edits().edits[0]!, find: '模型改写后的错误引文' }] })
  }, { steps: f.steps(), validate }), /exact current-text validation/)
  const oldDecisions = f.checkpoint().steps['repair:decisions'], calls: string[] = []
  const result = await generateScriptDraftRepairOutput(original, ids, async (sent, contract) => {
    calls.push(stage(contract))
    assert.equal(stage(contract), '_edits', 'continuation must not repeat whole repair or completed decisions')
    assert.ok(sent.indexOf('本次已确定具体决定') < sent.indexOf('技能合成例'))
    assert.ok(sent.indexOf('本次候选短目录') < sent.indexOf('技能合成例'))
    assert.ok(sent.indexOf('可替换来源（冻结段落原文）：') < sent.indexOf('技能合成例'))
    assert.match(sent, /本阶段没有可调用工具/); assert.match(sent, /不得使用中文占位/); assert.match(sent, /不能用压缩决定摘要缩减原始反馈范围/)
    assert.ok(text(contract!.schema).includes('replace_ref'))
    const paragraph = referencePart(referencedDocuments(sent)[0]!.parts, value => value.startsWith('规则六'))
    return text({ summary: '按既定方案修正文稿', source_edits: [], edits: [{ operation: 'replace_ref', source_key: 'world',
      ref_id: paragraph[0], replace: '规则六：保留熟练度满自动突破😀。', reason: '不新增瓶颈，保留其余内容' }] })
  }, { steps: f.steps(), validate, sources })
  assert.deepEqual(calls, ['_edits'])
  assert.deepEqual(f.checkpoint().steps['repair:decisions'], oldDecisions, 'the original decision prompt and identity remain byte-for-byte compatible')
  assert.equal(createDraftRepairReferences(sources).resolveEdits('world', result.edits)[0]!.find, '规则六：熟练度满自动突破😀。')
  assert.equal('ref_id' in result.edits[0]!, false, 'wire refs normalize to frozen paragraph IDs without copying long quotations')
  assert.ok('paragraph_id' in result.edits[0]!)
  await generateScriptDraftRepairOutput(original, ids, async () => assert.fail('the completed current reference repair replays without a new request'),
    { steps: f.steps(), validate, sources })
})

test('an exact completed legacy edits checkpoint is reused without silently changing its prompt or requiring refs', async () => {
  const f = fixture()
  await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    if (stage(contract) === 'whole') throw outputLimit()
    return text(stage(contract) === '_decisions' ? { decisions } : edits())
  }, { steps: f.steps() })
  const before = f.checkpoint(), steps = f.steps()
  steps.forget('repair')
  const result = await generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('exact old validated edits must remain recoverable'),
    { steps, sources: [{ key: 'world', content: '候选稿原文' }] })
  assert.deepEqual(result, whole())
  assert.deepEqual(steps.checkpoint.steps['repair:decisions'], before.steps['repair:decisions'])
  assert.deepEqual(steps.checkpoint.steps['repair:edits'], before.steps['repair:edits'])
})

// Recorded from the exact prior tail-reference implementation with this
// immutable fixture. These fixed hashes guard compatibility across the layout change.
const tailFixtureSources = [{ key: 'world', content: '冻结原段。' }]
const tailFixturePrompt = '完整技能与原反馈。\n可替换来源：' + text(tailFixtureSources)
const tailFixtureEdits = { summary: '落实反馈', source_edits: [], edits: [{ source_key: 'world', find: '冻结原段。', replace: '修订原段。', reason: '落实反馈' }] }
const tailFixtureCheckpoint = (): GenerationCheckpoint => ({ steps: {
  'repair:recovery': { input_hash: '18031d71fed9505f3a33d38eb9a563ff2521bbf6bdd8fcfa60ca1bc48f999100', value: 'decisions-then-edits' },
  'repair:decisions': { input_hash: '409b066d53c1811811125ddddbd32651355c73565910fb0d4704c872a3701734',
    value: { decisions: [{ issue_id: 'one', decision: '落实原反馈全部类别' }] } },
} })
const tailFixtureHash = '85cedc7198b892bd01004f278d95d34be65c94d6e3587676cffa6df501ad604b'

test('completed old tail-reference edits and exact unfinished pages retain their original identities', async t => {
  await t.test('completed edits', async () => {
    const f = fixture(), checkpoint = tailFixtureCheckpoint()
    checkpoint.steps['repair:edits'] = { input_hash: tailFixtureHash, value: tailFixtureEdits }; f.save(checkpoint)
    const result = await generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async () => assert.fail('validated old tail edits must replay without dispatch'),
      { steps: f.steps(), sources: tailFixtureSources })
    assert.deepEqual(result.edits, tailFixtureEdits.edits)
    assert.deepEqual(f.checkpoint().steps['repair:edits'], checkpoint.steps['repair:edits'])
  })
  await t.test('unfinished page with one retained operation', async () => {
    const f = fixture(), checkpoint = tailFixtureCheckpoint()
    checkpoint.steps['repair:edits:paging'] = { input_hash: tailFixtureHash, value: true }
    checkpoint.steps['repair:edits:pages'] = { input_hash: '993444f7d2158a38cba3f860e9b0427d0f7782dbf2fce46aee87e853f3cd79b4',
      value: { items: [{ kind: 'candidate', edit: tailFixtureEdits.edits[0] }], complete: false, page_size: 8 } }; f.save(checkpoint)
    const calls: string[] = []
    const result = await generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async (sent, contract) => {
      calls.push(stage(contract)); assert.equal(stage(contract), '_edits_page')
      assert.doesNotMatch(sent, /当前精确编辑阶段|完整原任务与资料（含技能和历史/)
      assert.ok(sent.indexOf('完整技能与原反馈。') < sent.indexOf('可替换来源（冻结段落原文）：'))
      assert.ok(sent.includes(text([{ kind: 'candidate', edit: tailFixtureEdits.edits[0] }])), 'the exact old page identity retains completed edits')
      return text({ items: [], complete: true })
    }, { steps: f.steps(), sources: tailFixtureSources })
    assert.deepEqual(calls, ['_edits_page']); assert.deepEqual(result.edits, tailFixtureEdits.edits)
  })
})

test('front-loaded completed edits win a stale tail paging marker and new pages resume without repeating edits', async t => {
  const assertFront = (sent: string) => {
    assert.ok(sent.indexOf('可替换来源（冻结段落原文）：') < sent.indexOf('完整技能与原反馈。'))
    assert.equal(sent.split('冻结原段。').length - 1, 1, 'the full candidate is moved without adding a duplicate copy')
    assert.equal(sent.split('完整技能与原反馈。').length - 1, 1)
  }
  await t.test('completed front result wins stale tail marker', async () => {
    const f = fixture(); f.save(tailFixtureCheckpoint())
    await generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async sent => { assertFront(sent); return text(tailFixtureEdits) },
      { steps: f.steps(), sources: tailFixtureSources })
    const saved = f.checkpoint(), completed = structuredClone(saved.steps['repair:edits'])
    saved.steps['repair:edits:paging'] = { input_hash: tailFixtureHash, value: true }; f.save(saved)
    await generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async () => assert.fail('a completed current edit must not be downgraded by stale paging metadata'),
      { steps: f.steps(), sources: tailFixtureSources })
    assert.deepEqual(f.checkpoint().steps['repair:edits'], completed)
  })
  await t.test('current front pages', async () => {
    const f = fixture(); f.save(tailFixtureCheckpoint())
    await assert.rejects(generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async (sent, contract) => {
      if (stage(contract) === '_edits') { assertFront(sent); throw outputLimit('{"edits":[' + text(tailFixtureEdits.edits[0]) + ',') }
      assert.equal(stage(contract), '_edits_page'); throw Object.assign(new TextProviderError('offline_stop_between_pages', false), { delivery: 'not_sent' }) // mock pauses before provider dispatch
    }, { steps: f.steps(), sources: tailFixtureSources }), /offline_stop_between_pages/)
    const calls: string[] = []
    const result = await generateScriptDraftRepairOutput(tailFixturePrompt, ['one'], async (sent, contract) => {
      calls.push(stage(contract)); assert.equal(stage(contract), '_edits_page')
      assert.ok(sent.indexOf('可替换来源（冻结段落原文）：') < sent.indexOf('完整技能与原反馈。'))
      assert.ok(sent.includes(text([{ kind: 'candidate', edit: tailFixtureEdits.edits[0] }])))
      return text({ items: [], complete: true })
    }, { steps: f.steps(), sources: tailFixtureSources })
    assert.deepEqual(calls, ['_edits_page']); assert.deepEqual(result.edits, tailFixtureEdits.edits)
  })
})

test('whole repair exposes exactly nine decisions on the wire and preserves the old validated checkpoint identity', async () => {
  const f = fixture(), calls: string[] = []
  const schema = createScriptDraftRepairOutputSchema(ids)
  assert.equal(schema.safeParse({ ...whole(), decisions: whole().decisions.slice(1) }).success, false)
  assert.equal(schema.safeParse({ ...whole(), decisions: [...whole().decisions, '多余决定'] }).success, false)
  const result = await generateScriptDraftRepairOutput(prompt, ids, async (sent, contract) => {
    calls.push(stage(contract)); assertFullContext(sent)
    const decisionSchema = (contract!.schema.properties as Record<string, { minItems?: number; maxItems?: number }>).decisions!
    assert.equal(decisionSchema.minItems, 9); assert.equal(decisionSchema.maxItems, 9)
    return text(whole())
  }, { steps: f.steps() })
  assert.deepEqual(result, whole()); assert.deepEqual(calls, ['whole'])
  assert.equal(has(f.checkpoint(), 'repair:recovery'), false)
  const resumed = await generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('old complete repair is reused'), { steps: f.steps() })
  assert.deepEqual(resumed, result)
  assert.ok(f.events.some(event => event.id === 'repair' && event.reused))
})

test('episode fallback repairs retain read-only timing and complete dialogue through whole and recovered requests', async t => {
  const sources = [{ key: 'scene:0:duration', content: '2' },
    { key: 'scene:0:dialogue', content: '先听我把昨晚的全部经过说完，然后再决定是否报警。' },
    { key: 'scene:0:action', content: '林晚讲述事故，停顿后等待对方回应。' }]
  const episodePrompt = `可替换来源：${JSON.stringify(sources)}`
  const timing = { unit: 'seconds' as const, estimated_total: 2, target_duration: 90 }
  const issueIds = ['scene-duration'], decision = '保留完整对白与动作，修正本场估时为45秒。'
  const patch = { summary: '修正场次估时', source_edits: [],
    edits: [{ source_key: 'scene:0:duration', find: '2', replace: '45', reason: '按完整对话及必要停顿估时' }] }
  for (const recover of [false, true]) await t.test(recover ? 'recovered' : 'whole', async () => {
    const stages: string[] = []
    const result = await generateScriptDraftRepairOutput(episodePrompt, issueIds, async (sent, contract) => {
      stages.push(stage(contract))
      const encodedTiming = /本集时长上下文（只读）：([^\n]+)/.exec(sent)?.[1]
      assert.ok(encodedTiming)
      assert.deepEqual(JSON.parse(encodedTiming), timing)
      assert.match(sent, /不能作为 source_key、quote 或补丁目标/)
      assert.match(sent, /估时修补应保留完整对白与动作/)
      assert.ok(sent.endsWith(episodePrompt), 'fallback and both recovery stages retain the complete original scene text')
      if (recover && stage(contract) === 'whole') throw outputLimit()
      if (stage(contract) === '_decisions') return text({ decisions: [{ issue_id: issueIds[0], decision }] })
      return text(stage(contract) === '_edits' ? patch : { ...patch, decisions: [decision] })
    }, { timing })
    assert.deepEqual(result, { ...patch, decisions: [decision] })
    assert.deepEqual(stages, recover ? ['whole', '_decisions', '_edits'] : ['whole'])
  })
})

test('timing changes invalidate complete fallback repair checkpoints even when the source prompt stays identical', async () => {
  const f = fixture(), timing = { unit: 'seconds' as const, estimated_total: 2, target_duration: 90 }
  await generateScriptDraftRepairOutput(prompt, ids, async () => text(whole()), { steps: f.steps(), timing })
  const reused = await generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('the same timing may reuse the completed patch'),
    { steps: f.steps(), timing })
  assert.deepEqual(reused, whole())
  let calls = 0
  await generateScriptDraftRepairOutput(prompt, ids, async sent => {
    calls++
    assert.ok(sent.includes('"target_duration":120'))
    return text(whole())
  }, { steps: f.steps(), timing: { ...timing, target_duration: 120 } })
  assert.equal(calls, 1)
})

test('two malformed whole results switch once to exact identified decisions then independent patches, with fresh step attempts', async () => {
  const f = fixture(), calls: string[] = [], attempts: number[] = [], validations: string[][] = []
  const invalidWhole = { ...whole(), summary: '不能把活动摘要当作具体决定', decisions: ['错误的合并决定'],
    edits: [{ ...edits().edits[0]!, replace: '不得采用的未验证补丁' }] }
  const result = await generateScriptDraftRepairOutput(prompt, ids, async (sent, contract) => {
    calls.push(stage(contract)); attempts.push(modelAttemptNumber()!); assertFullContext(sent)
    if (stage(contract) === 'whole') return text(invalidWhole)
    assert.equal(sent.includes('不得采用的未验证补丁'), false)
    if (stage(contract) === '_decisions') return text({ decisions: [...decisions].reverse() })
    assert.ok(sent.includes(`本次已确定具体决定：${JSON.stringify(decisions)}`))
    assert.equal(Object.hasOwn(contract!.schema.properties as object, 'decisions'), false)
    return text(edits())
  }, { steps: f.steps(), validate: value => { validations.push(value.decisions); assert.deepEqual(value.edits, edits().edits) } })
  assert.deepEqual(calls, ['whole', 'whole', '_decisions', '_edits'])
  assert.deepEqual(attempts, [1, 2, 1, 1], 'recovery stages do not inherit the failed whole request counter')
  assert.deepEqual(result, whole()); assert.ok(validations.length > 0)
  assert.ok(validations.every(value => value.every((decision, index) => decision === decisions[index]!.decision)))
  assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
  assert.equal(has(f.checkpoint(), 'repair:edits'), true)
  assert.equal(has(f.checkpoint(), 'repair'), true)
  assert.equal(Object.keys(f.checkpoint().steps).some(id => /^repair:\d+$/.test(id)), false)
  assert.deepEqual(f.events.filter(event => event.id === 'repair').map(event => event.status),
    ['running', 'failed', 'running', 'succeeded'], 'final aggregate replaces the failed whole step in the activity panel')
})

test('output-limit partial JSON is discarded and a patch failure retains the complete decision ledger for continuation', async () => {
  const f = fixture(), calls: string[] = [], failure = outputLimit(text(edits()))
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    calls.push(stage(contract))
    if (stage(contract) === 'whole') throw outputLimit(text(whole()))
    if (stage(contract) === '_decisions') return text({ decisions })
    throw failure
  }, { steps: f.steps() }), issue => issue === failure || issue instanceof ReviewPaginationStalledError && issue.cause === failure)
  assert.deepEqual(calls, ['whole', '_decisions', '_edits', '_edits_page', '_edits_page', '_edits_page', '_edits_page'])
  assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
  assert.equal(has(f.checkpoint(), 'repair:edits'), false)
  assert.equal(has(f.checkpoint(), 'repair'), false)
  const resumed: string[] = []
  const result = await generateScriptDraftRepairOutput(prompt, ids, async (sent, contract) => {
    resumed.push(stage(contract)); assertFullContext(sent)
    assert.ok(sent.includes(`本次已确定具体决定：${JSON.stringify(decisions)}`))
    assert.doesNotMatch(sent, /当前候选冻结段落引用/, 'an exact old incomplete page retains its original prompt and schema')
    return text({ items: [], complete: true })
  }, { steps: f.steps(), sources: [{ key: 'world', content: '候选稿原文' }] })
  assert.deepEqual(resumed, ['_edits_page']); assert.deepEqual(result.edits, whole().edits); assert.deepEqual(result.decisions, whole().decisions)
})

test('duplicate, foreign, omitted and empty decisions never become a ledger or allow patch generation', async t => {
  const schema = createScriptDraftRepairDecisionsSchema(ids)
  for (const invalid of ['duplicate', 'foreign', 'missing', 'empty']) await t.test(invalid, async () => {
    const f = fixture(), bad = structuredClone(decisions)
    if (invalid === 'duplicate') bad[8] = { ...bad[0]! }
    if (invalid === 'foreign') bad[8]!.issue_id = 'not-a-current-issue'
    if (invalid === 'missing') bad.pop()
    if (invalid === 'empty') bad[8]!.decision = '   '
    assert.equal(schema.safeParse({ decisions: bad }).success, false)
    const calls: string[] = []
    await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      calls.push(stage(contract))
      if (stage(contract) === 'whole') throw outputLimit()
      return text({ decisions: bad })
    }, { steps: f.steps() }), issue => {
      assert.equal((issue as { structuredOutputContract?: string }).structuredOutputContract, 'script_draft_repair_decisions')
      return true
    })
    assert.deepEqual(calls, ['whole', '_decisions', '_decisions'])
    assert.equal(has(f.checkpoint(), 'repair:decisions'), false)
    assert.equal(has(f.checkpoint(), 'repair'), false)
    const resumed: string[] = []
    await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      resumed.push(stage(contract)); assert.fail('restart cannot pay for a third decision correction')
    }, { steps: f.steps() }), (error: any) => error.structuredOutputContract === 'script_draft_repair_decisions')
    assert.deepEqual(resumed, []); assert.equal(has(f.checkpoint(), 'repair:decisions'), false)
  })
})

test('exact-edit validation remains mandatory during patch correction and continuation reuses decisions only', async () => {
  const f = fixture(), calls: string[] = [], invalidEdits = { ...edits(), edits: [{ ...edits().edits[0]!, find: '不存在的原文' }] }
  const validate = (value: ReturnType<typeof whole>) => {
    if (value.edits[0]?.find !== '候选稿原文') throw new Error('精确引文不属于当前候选稿')
  }
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    calls.push(stage(contract))
    if (stage(contract) === 'whole') throw outputLimit()
    return text(stage(contract) === '_decisions' ? { decisions } : invalidEdits)
  }, { steps: f.steps(), validate }), /精确引文不属于当前候选稿/)
  assert.deepEqual(calls, ['whole', '_decisions', '_edits', '_edits'])
  assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
  assert.equal(has(f.checkpoint(), 'repair:edits'), false)
  assert.equal(has(f.checkpoint(), 'repair'), false)
  const resumed: string[] = []
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    resumed.push(stage(contract)); assert.fail('failed completed correction cannot be paid again on restart')
  }, { steps: f.steps(), validate }), /精确引文不属于当前候选稿/)
  assert.deepEqual(resumed, []); assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
})

test('other structured contracts, provider/configuration failures and ordinary errors never activate repair recovery', async t => {
  const failures = [Object.assign(new Error('别的契约失败'), { structuredOutputContract: 'script_source_quality' }),
    new TextProviderError('无效密钥', false, 'invalid_api_key', 401), new Error('上下文超过限制'),
    Object.assign(new Error('请求次数已用尽'), { code: 'model_attempts_exhausted' })]
  for (const failure of failures) await t.test(failure.message, async () => {
    const f = fixture(), calls: string[] = []
    await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      calls.push(stage(contract)); throw failure
    }, { steps: f.steps() }), issue => issue === failure || issue instanceof ReviewPaginationStalledError && issue.cause === failure)
    assert.deepEqual(calls, ['whole'])
    assert.equal(has(f.checkpoint(), 'repair'), false); assert.equal(has(f.checkpoint(), 'repair:recovery'), false)
    assert.ok(Object.keys(f.checkpoint().steps).every(id => id.startsWith('repair:structured:')), 'private request intent is preserved without adopting a business result')
  })
})

test('the same shared usage budget spans failed whole, decisions and patches and cannot reset on continuation', async () => {
  const f = fixture(), usage = createScriptRequestUsage(), calls: string[] = []
  const generate = async (_sent: string, contract?: OutputContract) => {
    const request = beginTextRequest({ request_bytes: 100, estimated_input_tokens: 100, reserved_output_tokens: 100 })
    calls.push(stage(contract)); request.complete({ input_tokens: 100, output_tokens: 100 })
    if (stage(contract) === 'whole') throw outputLimit()
    return text(stage(contract) === '_decisions' ? { decisions } : edits())
  }
  const run = (limit: number) => withTextRequestUsage({ usage, limits: { max_requests: limit } },
    () => generateScriptDraftRepairOutput(prompt, ids, generate, { steps: f.steps() }))
  await assert.rejects(run(2), TextRequestBudgetError)
  assert.deepEqual(calls, ['whole', '_decisions']); assert.equal(usage.requests, 2)
  assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
  await assert.rejects(run(2), TextRequestBudgetError)
  assert.deepEqual(calls, ['whole', '_decisions']); assert.equal(usage.requests, 2)
  await run(3)
  assert.deepEqual(calls, ['whole', '_decisions', '_edits']); assert.equal(usage.requests, 3)
})

test('cancellation stops patch dispatch and preserves completed decisions for explicit continuation', async () => {
  const f = fixture(), controller = new AbortController(), reason = Object.assign(new Error('用户停止补齐'), { delivery: 'not_sent' }) // mock cancellation occurs before any provider dispatch
  const calls: string[] = []
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    calls.push(stage(contract))
    if (stage(contract) === 'whole') throw outputLimit()
    if (stage(contract) === '_decisions') return text({ decisions })
    controller.abort(reason); throw reason
  }, { signal: controller.signal, steps: f.steps(controller.signal) }), issue => issue === reason)
  assert.equal(has(f.checkpoint(), 'repair:decisions'), true)
  assert.equal(has(f.checkpoint(), 'repair'), false)
  const before = calls.length
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('aborted request must not dispatch'),
    { signal: controller.signal, steps: f.steps(controller.signal) }), issue => issue === reason)
  assert.equal(calls.length, before)
  const resumed: string[] = []
  await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    resumed.push(stage(contract)); return text(edits())
  }, { steps: f.steps() })
  assert.deepEqual(resumed, ['_edits'])
})

test('damaged validated decision children restore from exact raw without changing accepted decisions', async () => {
  const f = fixture()
  await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    if (stage(contract) === 'whole') throw outputLimit()
    return text(stage(contract) === '_decisions' ? { decisions } : edits())
  }, { steps: f.steps() })
  const checkpoint = f.checkpoint()
  ;(checkpoint.steps['repair:decisions']!.value as { decisions: unknown[] }).decisions = []
  f.save(checkpoint)
  const result = await generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('exact raw revalidates the original decisions without a new paid request'), { steps: f.steps() })
  assert.deepEqual(result, whole()); assert.deepEqual(f.checkpoint().steps['repair:decisions']!.value, { decisions })
  assert.deepEqual(f.checkpoint().steps.repair!.value, result)
})

test('damaged recovery children are replaced from exact raw before restoring complete aggregate', async t => {
  for (const child of ['repair:decisions', 'repair:edits']) await t.test(child, async () => {
    const f = fixture()
    await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      if (stage(contract) === 'whole') throw outputLimit()
      return text(stage(contract) === '_decisions' ? { decisions } : edits())
    }, { steps: f.steps() })
    const checkpoint = f.checkpoint(); checkpoint.steps[child]!.value = {}; f.save(checkpoint)
    const result = await generateScriptDraftRepairOutput(prompt, ids, async () => assert.fail('complete private raw must restore the damaged validated child locally'), { steps: f.steps() })
    assert.deepEqual(result, whole()); assert.deepEqual(f.checkpoint().steps.repair!.value, whole())
    assert.equal(has(f.checkpoint(), 'repair:recovery'), true)
    assert.ok(Object.keys(f.checkpoint().steps[child]!.value as object).length > 0)
  })
})

test('changing the full prompt invalidates the former strategy and starts a whole repair against the new complete work', async () => {
  const f = fixture()
  await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    if (stage(contract) === 'whole') throw outputLimit()
    if (stage(contract) === '_decisions') return text({ decisions })
    throw outputLimit()
  }, { steps: f.steps() }), ReviewPaginationStalledError)
  const calls: string[] = []
  await generateScriptDraftRepairOutput(prompt + '\n新的已授权资料', ids, async (_sent, contract) => {
    calls.push(stage(contract)); return text(whole())
  }, { steps: f.steps() })
  assert.deepEqual(calls, ['whole'])
})

}
