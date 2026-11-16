import { outputContract } from '../src/modules/generation/model-output.js'
import { draftReviewTaskSteps } from '../src/modules/script/script-draft-review-plan.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { createDraftReviewCoordinates, draftCoordinateSteps, generateDraftReviewCoordinates } from '../src/modules/script/script-draft-review-coordinates.js'
import { migrateDraftReviewCoordinates } from '../src/modules/script/script-draft-review-coordinate-migration.js'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution, draftReviewPromptInputs, draftCompletenessInput, draftCompletenessSources } from '../src/modules/script/script-draft-completeness.js'
import { scriptDraftReviewDimensionPrompts } from '../src/modules/script/script-draft-review-recovery.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { resolveModelTaskPolicy } from '../src/modules/generation/model-task-policy.js'

const source = { key: 'characters', artifact_type: 'characters', title: '角色档案', content: '林晚守护家人。\n铜钥匙消耗记忆。' }
const draft = { stage: 'characters' as const, scope: 'project' as const, episode_number: 0,
  artifacts: [{ artifact_type: 'characters' as const, title: source.title, content: source.content }], scenes: [] }
const context = { uploaded_script: { content: '完整原稿：林晚用铜钥匙救出家人。' }, source_version: 'v1' }
const clear = { facts: [], checked_artifacts: ['characters'], findings: [] }
const semantic = { kind: 'contradiction' as const, severity: 'blocking' as const,
  explanation: '记忆代价与原稿相反。', suggestion: '恢复记忆代价。' }
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
function coordinateFinding(coordinates: ReturnType<typeof createDraftReviewCoordinates>, document = 0) {
  const current = coordinates.material[document]!
  const unit = current.units.find(unit => unit.text.trim())!
  return { source_key: current.key, source_ref: current.source_ref, first_unit: unit.id, last_unit: unit.id, ...semantic }
}
function packet(prompt: string) {
  const marker = '待核对草稿原文（资料）：'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length).split('\n【本轮候选正文结束】')[0]!) as ReturnType<typeof createDraftReviewCoordinates>['material']
}
function freshResponse(prompt: string, withFinding = false) {
  const sources = packet(prompt), current = sources[0]!, unit = current.units.find(unit => unit.text.trim())!
  return JSON.stringify({ facts: [], checked_artifacts: [...new Set(sources.map(source => source.artifact_type))], findings: withFinding
    ? [{ source_key: current.key, source_ref: current.source_ref, first_unit: unit.id, last_unit: unit.id, ...semantic }] : [] })
}

test('coordinate material retains every candidate character once, including Unicode and whitespace', () => {
  const content = ' '.repeat(199) + '🙂' + '甲'.repeat(999) + '𠮷\n尾声！\n'
  const c = createDraftReviewCoordinates([{ ...source, content }])
  assert.equal(c.material[0]!.units.map(unit => unit.text).join(''), content)
  assert.equal('content' in c.material[0]!, false)
  assert.ok(c.material[0]!.units.every(unit => !/^[\uDC00-\uDFFF]/.test(unit.text) && !/[\uD800-\uDBFF]$/.test(unit.text)))
  const finding = coordinateFinding(c)
  const first = c.material[0]!.units.find(unit => unit.text.includes('🙂'))!
  const last = c.material[0]!.units.at(-1)!
  assert.equal(c.hydrateFinding({ ...finding, first_unit: first.id, last_unit: last.id }).quote,
    content.slice(c.material[0]!.units.slice(0, first.id).map(unit => unit.text).join('').length).trim())
})

test('only program-owned coordinates produce stored quotes and all semantic fields survive', () => {
  const c = createDraftReviewCoordinates([source]), finding = { ...coordinateFinding(c), topic: '记忆代价', first_unit: 2, last_unit: 2 }
  assert.deepEqual(c.hydrateFinding(finding), { source_key: source.key, ...semantic, topic: '记忆代价', quote: '铜钥匙消耗记忆。' })
})

for (const [label, change] of [
  ['unknown source', { source_key: 'uploaded_script' }], ['wrong source ref', { source_ref: 'not-current' }],
  ['missing unit', { first_unit: 9999 }], ['reversed range', { first_unit: 2, last_unit: 0 }],
  ['fractional unit', { first_unit: 0.5 }], ['negative unit', { last_unit: -1 }],
  ['copied quote', { quote: source.content }], ['invented field', { evidence: 0 }],
] as const) test(`strict coordinate wire rejects ${label}`, () => {
  const c = createDraftReviewCoordinates([source])
  assert.throws(() => c.hydrateFinding({ ...coordinateFinding(c), ...change }))
})

test('valid refs from another document cannot be paired with this source key', () => {
  const c = createDraftReviewCoordinates([source, { ...source, key: 'relationships', content: '两人互相信任。' }])
  assert.throws(() => c.hydrateFinding({ ...coordinateFinding(c), source_ref: c.material[1]!.source_ref }), /来源版本/)
})

test('source refs change on document identity or bytes, retaining stable exact-source refs', () => {
  const ref = createDraftReviewCoordinates([source]).material[0]!.source_ref
  assert.equal(ref, createDraftReviewCoordinates([{ ...source }]).material[0]!.source_ref)
  assert.notEqual(ref, createDraftReviewCoordinates([{ ...source, content: source.content + ' ' }]).material[0]!.source_ref)
  assert.notEqual(ref, createDraftReviewCoordinates([{ ...source, key: 'world' }]).material[0]!.source_ref)
})

test('empty evidence and overlong continuous evidence remain errors', () => {
  const blank = createDraftReviewCoordinates([{ ...source, content: '\n \t\n' }])
  assert.throws(() => blank.hydrateFinding({ ...coordinateFinding(createDraftReviewCoordinates([source])), source_ref: blank.material[0]!.source_ref, first_unit: 0, last_unit: 0 }), /非空/)
  const long = createDraftReviewCoordinates([{ ...source, content: '甲'.repeat(4200) }])
  assert.throws(() => long.hydrateFinding({ ...coordinateFinding(long), last_unit: long.material[0]!.units.at(-1)!.id }), /4000/)
})

test('fresh report must cover every submitted artifact exactly once and facts stay empty', () => {
  const c = createDraftReviewCoordinates([source])
  for (const invalid of [{ ...clear, facts: ['invented'] }, { ...clear, checked_artifacts: ['characters', 'characters'] },
    { ...clear, checked_artifacts: ['world'] }]) assert.throws(() => c.hydrate(invalid))
})

test('valid fresh finding completes in one semantic call without an evidence locator', async () => {
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    calls++
    assert.equal(contract!.name, 'script_draft_completeness_coordinates')
    assert.equal(contract!.request_policy, 'script_review')
    assert.ok(prompt.includes(context.uploaded_script.content))
    assert.equal(packet(prompt)[0]!.units.map(unit => unit.text).join(''), source.content)
    assert.match(prompt, /禁止返回 quote/)
    return freshResponse(prompt, true)
  }, { context }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings[0]!.quote, '林晚守护家人。')
    return true
  })
  assert.equal(calls, 1)
  assert.equal(resolveModelTaskPolicy('script_draft_completeness_coordinates').purpose, 'review')
  assert.equal(resolveModelTaskPolicy('script_draft_completeness_coordinates_page').purpose, 'review')
})

test('new successful checkpoints reuse exact inputs and invalidate source or context changes', async () => {
  const steps = createGenerationSteps()
  let calls = 0
  const generate = async (prompt: string) => { calls++; return freshResponse(prompt) }
  await reviewScriptDraftCompleteness(draft, generate, { context, steps })
  await reviewScriptDraftCompleteness(draft, generate, { context, steps })
  assert.equal(calls, 1)
  await reviewScriptDraftCompleteness(draft, generate, { context: { ...context, source_version: 'v2' }, steps })
  assert.equal(calls, 2)
  await reviewScriptDraftCompleteness({ ...draft, artifacts: [{ ...draft.artifacts[0]!, content: source.content + '尾声。' }] }, generate, { context, steps })
  assert.equal(calls, 3)
  assert.ok(steps.checkpoint.steps['review:coordinates:v1:review:whole'])
  assert.equal(steps.checkpoint.steps['review:whole'], undefined)
})

test('full-review output limit retains strict coordinate seeds for independent dimensions', async () => {
  const c = createDraftReviewCoordinates([source]), item = coordinateFinding(c), steps = createGenerationSteps()
  await assert.rejects(generateDraftReviewCoordinates('完整任务', c, async () => {
    throw new TextOutputLimitError('{"findings":[' + JSON.stringify(item) + ', ', 'max_tokens')
  }, value => value, { steps }), TextOutputLimitError)
  const seed = Object.values(steps.checkpoint.steps)[0]!.value
  assert.deepEqual(seed, [item])
  let calls = 0
  const result = await generateDraftReviewCoordinates('完整任务', c, async (_prompt, contract) => {
    calls++
    assert.equal(contract!.name, 'script_draft_completeness_coordinates_page')
    return JSON.stringify({ items: [], complete: true })
  }, value => value, { steps, paged: true })
  assert.equal(calls, 1)
  assert.equal((result as typeof clear).findings.length, 1)
})

test('invalid closed coordinate items never become partial paid evidence', async () => {
  const c = createDraftReviewCoordinates([source]), steps = createGenerationSteps()
  await assert.rejects(generateDraftReviewCoordinates('完整任务', c, async () => {
    throw new TextOutputLimitError('{"findings":[' + JSON.stringify({ ...coordinateFinding(c), source_ref: 'wrong' }) + ',', 'max_tokens')
  }, value => value, { steps }))
  assert.deepEqual(steps.checkpoint.steps, {})
})

test('exact old whole success migrates using frozen pre-coordinate prompt hash without a model call', async () => {
  // Captured with the previous production prompt builder for this exact draft/context.
  const oldHash = 'd130965c287ce89be4ff432b90b95c3bb7dad720285cda039c4893987c943e8b'
  const steps = createGenerationSteps({ checkpoint: { steps: { 'review:whole': { input_hash: oldHash, value: clear } } } })
  await reviewScriptDraftCompleteness(draft, async () => assert.fail('exact old completed assessment must not be purchased again'), { context, steps })
  assert.equal(steps.checkpoint.steps['review:whole']!.input_hash, oldHash)
  assert.deepEqual(steps.checkpoint.steps['review:coordinates:v1:review:whole']!.value, clear)
})

test('exact old provisional only resumes its original locator and retains semantic finding', async () => {
  const id = 'review:response:3ca041ab56d4574a2707b683d4ae1196bb5a319c5cba249925a142c9232b9d04'
  const input_hash = '4e5f7415ef729571a0c9b1fcf5da9376feb93d30b2e2feaee6b88903f3085d9c'
  const steps = createGenerationSteps({ checkpoint: { steps: { [id]: { input_hash,
    value: { ...clear, findings: [{ source_key: 'characters', quote: '铜钥匙没有代价。', ...semantic }] } } } } })
  const calls: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(draft, async (_prompt, contract) => {
    calls.push(contract!.name)
    assert.equal(contract!.name, 'script_draft_evidence_repair')
    return JSON.stringify({ repairs: [{ id: 'findings:0', first_unit: 2, last_unit: 2 }] })
  }, { context, steps }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.deepEqual(issue.findings[0], { id: issue.findings[0]!.id, source_key: 'characters', kind: 'contradiction',
      quote: '铜钥匙消耗记忆。', explanation: semantic.explanation, suggestion: semantic.suggestion })
    return true
  })
  assert.deepEqual(calls, ['script_draft_evidence_repair'])
  assert.equal(steps.checkpoint.steps[id], undefined)
})

function migrationFixture() {
  const legacySteps = createGenerationSteps(), steps = draftCoordinateSteps(legacySteps)!
  const legacyPrompt = '完整旧候选与背景', prompt = '完整坐标候选与背景'
  let legacyCalls = 0
  const options = { legacyPrompt, prompt, legacySteps, steps, validate: (value: unknown) => {
    assert.deepEqual(value, clear); return clear
  }, validateCombined: (value: unknown) => { assert.deepEqual(value, clear); return clear },
    legacyReview: async () => { legacyCalls++; return clear } }
  return { legacySteps, steps, options, legacyCalls: () => legacyCalls }
}

test('completed old dimensions migrate only on exact inputs; scope/context hashes never weaken', async () => {
  const f = migrationFixture(), old = scriptDraftReviewDimensionPrompts(f.options.legacyPrompt)
  f.legacySteps.retain('review:dimension:settings', '已完成', { version: 1, prompt: old[0]!.prompt }, clear, value => value)
  f.legacySteps.retain('review:dimension:consistency', '其他上下文', { version: 1, prompt: 'different input' }, clear, value => value)
  f.legacySteps.retain('review:recovery', '分项', { version: 1, prompt: f.options.legacyPrompt }, 'dimensions', value => value)
  const oldSnapshot = structuredClone(f.legacySteps.checkpoint.steps['review:dimension:settings'])
  assert.equal(await migrateDraftReviewCoordinates(f.options), undefined)
  const next = scriptDraftReviewDimensionPrompts(f.options.prompt)
  assert.equal(f.steps.checkpoint.steps['review:dimension:settings']!.input_hash, hash({ version: 1, prompt: next[0]!.prompt }))
  assert.equal(f.steps.checkpoint.steps['review:dimension:consistency'], undefined)
  assert.equal(f.steps.checkpoint.steps['review:recovery']!.value, 'dimensions')
  assert.deepEqual(f.legacySteps.checkpoint.steps['review:dimension:settings'], oldSnapshot)
  assert.equal(f.legacyCalls(), 0)
})

test('exact old private pages are preserved and explicitly block unsupported migration', async () => {
  const f = migrationFixture(), id = 'review:response:' + createHash('sha256').update(f.options.legacyPrompt).digest('hex') + ':pages'
  f.legacySteps.retain(id, '旧分页', { private: true }, { items: ['retained'], complete: false }, value => value)
  const old = structuredClone(f.legacySteps.checkpoint)
  await assert.rejects(migrateDraftReviewCoordinates(f.options), { code: 'script_draft_review_protocol_migration_required' })
  assert.deepEqual(f.legacySteps.checkpoint, old)
  assert.equal(f.legacyCalls(), 0)
})

test('strategy migration keeps answer and paging facts without replacing a newer exact policy', async () => {
  const f = migrationFixture(), old = { version: 3, prompt: f.options.legacyPrompt }, current = { version: 3, prompt: f.options.prompt }
  f.legacySteps.retain('review:reasoning:review:whole', '已耗尽', { version: 1, input: old }, { mode: 'blocked' }, value => value)
  await migrateDraftReviewCoordinates(f.options)
  assert.deepEqual(f.steps.checkpoint.steps['review:reasoning:review:whole']!.value, { mode: 'blocked' })
  f.steps.retain('review:reasoning:review:whole', '新策略', { version: 1, input: current }, { mode: 'answer' }, value => value)
  await migrateDraftReviewCoordinates(f.options)
  assert.deepEqual(f.steps.checkpoint.steps['review:reasoning:review:whole']!.value, { mode: 'answer' })
})

test('invalid old completed evidence never becomes success or gets silently discarded', async () => {
  const f = migrationFixture()
  f.legacySteps.retain('review:whole', '旧成功', { version: 3, prompt: f.options.legacyPrompt }, { fabricated: true }, value => value)
  const before = structuredClone(f.legacySteps.checkpoint)
  await assert.rejects(migrateDraftReviewCoordinates(f.options), { code: 'script_draft_review_protocol_migration_required' })
  assert.deepEqual(f.legacySteps.checkpoint, before)
  assert.equal(f.legacyCalls(), 0)
})

test('two local tasks still precede a mandatory full candidate global consistency review', async () => {
  const submitted = { ...draft, stage: 'outline' as const, artifacts: [
    { artifact_type: 'outline' as const, title: '大纲', content: '主线从营救家人开始。' },
    { artifact_type: 'world' as const, title: '背景设定', content: '铜钥匙消耗记忆。' },
  ] }
  const calls: string[][] = []
  await reviewScriptDraftCompleteness(submitted, async prompt => {
    const material = packet(prompt)
    calls.push(material.map(source => source.key))
    assert.ok(prompt.includes(context.uploaded_script.content))
    return freshResponse(prompt)
  }, { context, review_scope: 'tasks' })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.at(-1), ['outline', 'world'])
})

test('fresh copied quote wire gets bounded contract correction and never invokes the old locator', async () => {
  const names: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(draft, async (_prompt, contract) => {
    names.push(contract!.name)
    return JSON.stringify({ ...clear, findings: [{ source_key: source.key, quote: source.content, ...semantic }] })
  }, { context }))
  assert.deepEqual(names, ['script_draft_completeness_coordinates', 'script_draft_completeness_coordinates'])
})

test('coordinate recovery retains complete dimensions and resumes only the unfinished dimension', async () => {
  const steps = createGenerationSteps(), calls: string[] = []
  const dimension = (prompt: string) => /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
  await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
    const task = dimension(prompt); calls.push(task)
    if (task === 'whole') throw new TextOutputLimitError('', 'max_tokens')
    if (task === 'consistency') throw Object.assign(new Error('provider disconnected'), { delivery: 'not_sent' })
    return freshResponse(prompt)
  }, { context, steps }), /provider disconnected/)
  assert.deepEqual(calls, ['whole', 'settings', 'consistency'])
  calls.length = 0
  await reviewScriptDraftCompleteness(draft, async prompt => { calls.push(dimension(prompt)); return freshResponse(prompt) }, { context, steps })
  assert.deepEqual(calls, ['consistency', 'requirements'])
  assert.ok(steps.checkpoint.steps['review:coordinates:v1:review:whole'])
})

test('pure reasoning exhaustion changes coordinate answer policy without losing the full source', async () => {
  const policies: unknown[] = [], steps = createGenerationSteps()
  await reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    policies.push(contract!.request_policy)
    assert.equal(contract!.name, 'script_draft_completeness_coordinates')
    assert.equal(packet(prompt)[0]!.units.map(unit => unit.text).join(''), source.content)
    assert.ok(prompt.includes(context.uploaded_script.content))
    if (policies.length === 1) throw new TextOutputLimitError('', 'max_output_tokens', { output_tokens: 100, reasoning_tokens: 100 })
    return freshResponse(prompt)
  }, { context, steps, answerModeSupported: true })
  assert.deepEqual(policies, ['script_review', 'script_review_answer'])
  assert.deepEqual(steps.checkpoint.steps['review:coordinates:v1:review:reasoning:review:whole']!.value,
    { mode: 'answer', reason: 'max_output_tokens', usage: { output_tokens: 100, reasoning_tokens: 100 } })
})

test('focused coordinate exhaustion switches to strict coordinate pages', async () => {
  const calls: Array<[string, string]> = [], steps = createGenerationSteps()
  await reviewScriptDraftCompleteness(draft, async (prompt, contract) => {
    const dimension = /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
    calls.push([dimension, contract!.name])
    if (dimension === 'whole' || dimension === 'settings' && !contract!.name.endsWith('_page')) {
      throw new TextOutputLimitError('', 'max_tokens')
    }
    return contract!.name.endsWith('_page') ? JSON.stringify({ items: [], complete: true }) : freshResponse(prompt)
  }, { context, steps })
  assert.deepEqual(calls, [['whole', 'script_draft_completeness_coordinates'], ['settings', 'script_draft_completeness_coordinates'],
    ['settings', 'script_draft_completeness_coordinates_page'], ['consistency', 'script_draft_completeness_coordinates'],
    ['requirements', 'script_draft_completeness_coordinates']])
})

function legacyPrivateFixture(state: Record<string, unknown>, changedContext = context) {
  const options = { context: changedContext, intent: undefined }
  const { prompt } = draftReviewPromptInputs(draft, draftCompletenessSources(draft), options)
  const name = 'script_draft_completeness', schema = outputContract(name, draftCompletenessInput).schema
  const input = { version: 3, prompt }, parent_input_hash = hash(input)
  const bindingHash = hash({ parent_input_hash, name, prompt, schema })
  const input_hash = hash([name, schema, prompt])
  const id = `response:review:whole:${bindingHash}`
  const steps = createGenerationSteps({ checkpoint: { steps: { [id]: { input_hash: bindingHash,
    value: { input_hash, ...state, ...(state.initial_started ? { initial_started: { input_hash } } : {}) } } } } })
  return { steps, id, prompt, schema, input }
}

test('an exact factory unknown old request blocks coordinate migration without a new dispatch', async () => {
  const f = legacyPrivateFixture({ initial_started: true }), before = structuredClone(f.steps.checkpoint)
  await assert.rejects(reviewScriptDraftCompleteness(draft, async () => assert.fail('unknown old dispatch cannot be bypassed by a new coordinate name'),
    { context, steps: f.steps }), { code: 'structured_initial_delivery_pending' })
  assert.deepEqual(f.steps.checkpoint, before)
})

test('an exact complete factory raw response is validated locally through the old protocol', async () => {
  const f = legacyPrivateFixture({ raw: JSON.stringify(clear), original_raw: JSON.stringify(clear) })
  await reviewScriptDraftCompleteness(draft, async () => assert.fail('exact complete private response must not be purchased again'), { context, steps: f.steps })
  assert.equal((f.steps.checkpoint.steps[f.id]!.value as { raw: string }).raw, JSON.stringify(clear))
  assert.deepEqual(f.steps.checkpoint.steps['review:coordinates:v1:review:whole']!.value, clear)
})

test('a different exact context has independent coordinates and does not inherit another request unknown gate', async () => {
  const f = legacyPrivateFixture({ initial_started: true }), old = structuredClone(f.steps.checkpoint.steps[f.id]), calls: string[] = []
  await reviewScriptDraftCompleteness(draft, async (prompt, contract) => { calls.push(contract!.name); return freshResponse(prompt) },
    { context: { ...context, source_version: 'independent-v2' }, steps: f.steps })
  assert.deepEqual(calls, ['script_draft_completeness_coordinates'])
  assert.deepEqual(f.steps.checkpoint.steps[f.id], old)
})

test('scoped private response readers bind the actual task prefix and full request tuple', () => {
  const steps = createGenerationSteps(), scoped = draftReviewTaskSteps(steps, 'story')!
  const input = { version: 3, prompt: 'old task' }, schema = { type: 'object' }, name = 'script_draft_completeness', prompt = 'old task'
  const parent_input_hash = hash(input), binding = hash({ parent_input_hash, name, prompt, schema })
  steps.checkpoint.steps[`response:review:task:story:review:whole:${binding}`] = { input_hash: binding, value: { input_hash: 'request', raw: 'complete' } }
  assert.equal(scoped.readStructuredResponse!('review:whole', input, name, prompt, schema)!.raw, 'complete')
  assert.equal(scoped.readStructuredResponse!('review:whole', { version: 4, prompt }, name, prompt, schema), undefined)
  assert.equal(scoped.readStructuredResponse!('review:whole', input, name + '_page', prompt, schema), undefined)
  assert.equal(scoped.readStructuredResponse!('review:whole', input, name, prompt, { type: 'array' }), undefined)
})
