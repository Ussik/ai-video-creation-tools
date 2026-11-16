import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
const directory = await mkdtemp(join(tmpdir(), 'repair-worksets-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'))
const { generateScriptDraftRepairWorksets } = await import('../src/modules/script/script-draft-repair-worksets.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const identity = { candidate_id: 'candidate', candidate_version: 'version', source_version: 'source' }
const sources = [{ key: 'outline', content: '大纲代价未定。' }, { key: 'world', content: '世界规则正确。' }, { key: 'constraints', content: '不得改身份。' }]
const source = '完整原稿：钥匙使用代价未定。'
const decisions = { decisions: [{ issue_id: 'issue', decision: '每次使用失去当日记忆，保留人物身份。' }] }
const base = '完整技能规则和历史。完整原稿：' + source + '全部原始反馈：补齐使用代价并同步相关文档。'
const output = (edits: any[] = [], source_edits: any[] = []) => ({ decisions: [decisions.decisions[0]!.decision], summary: '完成', edits, source_edits })
const edit = { source_key: 'outline', find: sources[0]!.content, replace: '大纲代价为当日记忆。', reason: '落实代价' }
const sourceEdit = { find: source, replace: source.replace('代价未定', '代价为当日记忆'), reason: '落实明确同步' }
const common = () => ({ prompt: base, issueIds: ['issue'], sources, currentSource: source, referenceIdentity: identity, executionIdentity: { model: 'configured', provider: 'test' }, validate: (_value: unknown) => {} })
const keyIn = (prompt: string, key: string) => prompt.includes(`【当前工作集：["${key}"]】`)

test('worksets keep complete rules/source/feedback and only their own candidate text, group fields by scene, then validate once atomically', async () => {
  const withScenes = [...sources, ...['heading', 'action', 'dialogue', 'duration'].map((key, index) => ({ key: `scene:0:${key}`, content: String(['车站', '完整动作。', '完整对白。', '45'][index]) }))]
  let calls = 0, maxActive = 0, active = 0, validated = 0
  const seen: string[] = []
  const generate: StructuredGenerator = async (prompt, contract) => {
    calls++; assert.ok(prompt.includes(base))
    if (contract!.name.endsWith('decisions')) {
      assert.ok(!prompt.includes(sources[0]!.content)); return JSON.stringify(decisions)
    }
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    try {
      if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '原稿无需修改', source_edits: [] })
      const match = /【当前工作集：(\[[^\n]+\])】/.exec(prompt)!
      const keys: string[] = JSON.parse(match[1]!); seen.push(...keys)
      assert.ok(prompt.includes(JSON.stringify(decisions.decisions)))
      const frozen = JSON.parse(prompt.split('可替换来源（冻结段落原文）：')[1]!.split('\n')[0]!)
      assert.deepEqual(frozen.map((item: any) => item.source_key), keys)
      for (const item of frozen) assert.equal(item.parts.map((part: string | [string, string]) => Array.isArray(part) ? part[1] : part).join(''), withScenes.find(source => source.key === item.source_key)!.content)
      for (const item of sources) assert.equal(prompt.includes(item.content), keys.includes(item.key), 'other candidate documents stay outside this workset')
      return JSON.stringify({ summary: '逐份核对', edits: keys.includes('outline') ? [edit] : [] })
    } finally { active-- }
  }
  const result = await generateScriptDraftRepairWorksets({ ...common(), sources: withScenes, generate, validate: patch => { validated++; assert.deepEqual(patch.edits, [edit]) } })
  assert.equal(calls, 6, 'one decisions, three artifacts, one entire scene, one source task')
  assert.equal(maxActive, 2)
  assert.deepEqual(seen.sort(), withScenes.map(item => item.key).sort())
  assert.equal(result.source_edits.length, 0); assert.ok(validated >= 1)
})

test('source-only repair is valid, candidate workers cannot submit source_edits, and empty total output cannot complete', async () => {
  let sourceCalls = 0
  const generate: StructuredGenerator = async (_prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) { sourceCalls++; return JSON.stringify({ summary: '仅同步原稿', source_edits: [sourceEdit] }) }
    return JSON.stringify({ summary: '候选已正确', edits: [] })
  }
  const result = await generateScriptDraftRepairWorksets({ ...common(), generate })
  assert.equal(sourceCalls, 1); assert.deepEqual(result.edits, []); assert.deepEqual(result.source_edits, [sourceEdit])
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), generate: async (_prompt, contract) => contract!.name.endsWith('decisions') ? JSON.stringify(decisions)
    : contract!.name.endsWith('source') ? JSON.stringify({ summary: '无需修改', source_edits: [] }) : JSON.stringify({ summary: '无需修改', edits: [] }) }), /没有产生有效正文修改|至少提交一处/)
  const candidateSchema: any[] = []
  await generateScriptDraftRepairWorksets({ ...common(), generate: async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '无需修改', source_edits: [] })
    candidateSchema.push(contract!.schema)
    return JSON.stringify({ summary: '落实', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  } })
  assert.ok(candidateSchema.every(schema => !JSON.stringify(schema).includes('source_edits')))
})

test('failed child keeps completed siblings, resumes only missing work, and corrupt children invalidate aggregate completion', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, fail = true
  const calls = new Map<string, number>(); let validated = 0
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    const key = contract!.name.endsWith('decisions') ? 'decisions' : contract!.name.endsWith('source') ? 'source' : sources.find(item => keyIn(prompt, item.key))!.key
    calls.set(key, (calls.get(key) || 0) + 1)
    if (key === 'decisions') return JSON.stringify(decisions)
    if (key === 'world' && fail) { await new Promise(resolve => setTimeout(resolve, 8)); throw Object.assign(new Error('child failure'), { delivery: 'not_sent' }) }
    if (key === 'source') return JSON.stringify({ summary: '无需修改', source_edits: [] })
    return JSON.stringify({ summary: '完整子成果', edits: key === 'outline' ? [edit] : [] })
  }
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate, validate: () => { validated++ } }), /child failure/)
  assert.equal(validated, 0)
  assert.ok(Object.keys(checkpoint.steps).some(key => key.startsWith('repair:worksets:candidate:')))
  assert.equal(checkpoint.steps['repair:worksets:aggregate'], undefined)
  fail = false
  await generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate, validate: () => { validated++ } })
  assert.equal(calls.get('decisions'), 1); assert.equal(calls.get('outline'), 1); assert.equal(calls.get('world'), 2)
  assert.ok(checkpoint.steps['repair:worksets:aggregate'])
  const child = Object.values(checkpoint.steps).find(step => (step.value as any)?.edits?.[0]?.source_key === 'outline')!
  child.value = { summary: 'damaged', edits: [{ ...edit, find: 'not in current version' }] }
  const before = calls.get('outline')!
  await generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate })
  assert.equal(calls.get('outline'), before, 'damaged business child is reconstructed from its exact paid raw proposal and fully revalidated')
  assert.deepEqual((child.value as any).edits, [{ ...edit, find: 'not in current version' }], 'old object is detached')
})

test('child identity binds full document, creator context and source version; read-only source suppresses source worker', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, candidates = 0, sourceCalls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) { sourceCalls++; return JSON.stringify({ summary: '无需修改', source_edits: [] }) }
    candidates++; return JSON.stringify({ summary: '修订', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await generateScriptDraftRepairWorksets({ ...common(), sourceReadOnly: true, steps: steps(), generate })
  assert.equal(sourceCalls, 0); assert.equal(candidates, 3)
  await generateScriptDraftRepairWorksets({ ...common(), sourceReadOnly: true, steps: steps(), generate })
  assert.equal(candidates, 3)
  await generateScriptDraftRepairWorksets({ ...common(), prompt: base + '新增完整用户反馈。', sourceReadOnly: true, steps: steps(), generate })
  assert.equal(candidates, 6)
  await generateScriptDraftRepairWorksets({ ...common(), prompt: base + '新增完整用户反馈。', sources: sources.map(item => item.key === 'world' ? { ...item, content: item.content + '新增背景。' } : item), sourceReadOnly: true, steps: steps(), generate })
  assert.equal(candidates, 7, 'unchanged docs reuse exact decisions and complete input; only changed full document reruns')
})

test('whole-patch business validation rejects conflict without adopting any child, and cancellation wins after active workers settle', async () => {
  const controller = new AbortController(); let started = 0, validated = 0
  const generate: StructuredGenerator = async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '无需修改', source_edits: [] })
    return JSON.stringify({ summary: '修订', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), generate, validate: () => { throw Object.assign(new Error('current source conflict'), { statusCode: 409 }) } }), /current source conflict/)
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), signal: controller.signal, generate: async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    started++
    await new Promise(resolve => setTimeout(resolve, 2))
    controller.abort(new Error('cancelled by creator'))
    return JSON.stringify({ summary: '修订', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }, validate: () => { validated++ } }), /cancelled by creator/)
  assert.ok(started <= 2); assert.equal(validated, 0)
})

test('a complete-looking partial child is never checkpointed or adopted', async () => {
  const { TextOutputLimitError } = await import('../src/infrastructure/providers/text-errors.js')
  let checkpoint: GenerationCheckpoint = { steps: {} }, validated = 0
  const steps = createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), steps, validate: () => { validated++ }, generate: async (_prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    throw new TextOutputLimitError(JSON.stringify({ summary: '看似完整但被截断', edits: [edit] }), 'length')
  } }), error => error instanceof TextOutputLimitError)
  assert.equal(validated, 0)
  assert.equal(checkpoint.steps['repair:worksets:aggregate'], undefined)
  assert.ok(!Object.keys(checkpoint.steps).some(key => key.startsWith('repair:worksets:candidate:')))
})

test('execution model changes invalidate every workset child without changing the immutable candidate', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    calls++
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '无需修改', source_edits: [] })
    return JSON.stringify({ summary: '修订', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate })
  assert.equal(calls, 5)
  await generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate })
  assert.equal(calls, 5)
  await generateScriptDraftRepairWorksets({ ...common(), executionIdentity: { model: 'changed-fixture', provider: 'test' }, steps: steps(), generate })
  assert.equal(calls, 10)
})

test('explicit manual plans retain all 4000 characters and issue order without any model decision request', async () => {
  const plans = ['保留全部原稿事件；' + '甲'.repeat(3989), '此项委托AI决定必要细节。']
  let calls = 0, validated = 0
  const result = await generateScriptDraftRepairWorksets({ ...common(), issueIds: ['first', 'second'], manualPlans: plans, generate: async (prompt, contract) => {
    calls++; assert.ok(!contract!.name.endsWith('decisions'))
    assert.ok(prompt.includes(plans[0]!)); assert.ok(prompt.includes(plans[1]!))
    assert.ok(prompt.includes('尚未明确的细节或交由AI决定的部分'))
    assert.ok(!prompt.includes('【已固定具体决定，不可改写】'))
    if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '原稿已正确', source_edits: [] })
    return JSON.stringify({ summary: '在正文落实完整方案', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }, validate: patch => { validated++; assert.deepEqual(patch.decisions, plans) } })
  assert.deepEqual(result.decisions, plans); assert.equal(calls, 4); assert.ok(validated > 0)
  const { createAuthoritativeManualRepairSchema } = await import('../src/modules/script/script-draft-repair-generation.js')
  const exact = createAuthoritativeManualRepairSchema(['first', 'second'], plans).schema
  assert.equal(exact.safeParse({ ...result, decisions: [...plans].reverse() }).success, false)
  assert.equal(exact.safeParse({ ...result, decisions: plans.slice(1) }).success, false)
  for (const invalid of [[], [''], ['甲'.repeat(4001)], ['缺一项']]) {
    await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), issueIds: ['first', 'second'], manualPlans: invalid,
      generate: async () => assert.fail('invalid manual UI plans must reject before model requests') }))
  }
})

test('manual plan identity replaces unfinished AI decisions and invalidates children when plans change', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0, decisionCalls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    calls++
    if (contract!.name.endsWith('decisions')) { decisionCalls++; return JSON.stringify(decisions) }
    if (contract!.name.endsWith('source')) return JSON.stringify({ summary: '无需修改', source_edits: [] })
    return JSON.stringify({ summary: '修订', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await generateScriptDraftRepairWorksets({ ...common(), steps: steps(), generate })
  const oldDecisionHash = checkpoint.steps['repair:worksets:decisions']!.input_hash
  assert.equal(calls, 5); assert.equal(decisionCalls, 1)
  const plans = ['作者明确方案。' + '乙'.repeat(2700)]
  await generateScriptDraftRepairWorksets({ ...common(), manualPlans: plans, steps: steps(), generate })
  assert.notEqual(checkpoint.steps['repair:worksets:decisions']!.input_hash, oldDecisionHash)
  assert.equal(calls, 9); assert.equal(decisionCalls, 1)
  await generateScriptDraftRepairWorksets({ ...common(), manualPlans: plans, steps: steps(), generate })
  assert.equal(calls, 9)
  await generateScriptDraftRepairWorksets({ ...common(), manualPlans: [plans[0] + '新增约束。'], steps: steps(), generate })
  assert.equal(calls, 13); assert.equal(decisionCalls, 1)
})

test('manual authority never makes unchanged output pass or marks a finding verified', async () => {
  const { rememberFindingResolutions } = await import('../src/modules/script/script-finding-state.js')
  const plan = '遵照原稿并由AI落实缺失细节。' + '丙'.repeat(3900)
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), manualPlans: [plan], generate: async (_prompt, contract) => contract!.name.endsWith('source')
    ? JSON.stringify({ summary: '已全部修好', source_edits: [] }) : JSON.stringify({ summary: '已全部修好', edits: [] }) }), /至少提交一处|没有产生有效正文修改/)
  const finding = { source_key: 'outline', kind: 'unresolved_setting' as const, quote: '代价未定', explanation: '代价缺失', suggestion: '明确代价' }
  const record = rememberFindingResolutions([], [finding], 'manual', [plan], '落实后还需独立复核', [plan])[0]!
  assert.equal(record.answer, plan); assert.equal(record.decision, plan); assert.equal(record.status, 'addressed')
  const generated = rememberFindingResolutions([], [finding], 'manual', [plan], '生成决定', [plan + '模型重述'])[0]!
  assert.equal(generated.answer, plan); assert.equal(generated.decision!.length, 3000)
})


test('source-only transport upgrade reuses all nine completed candidate worksets and binds only the missing source worker', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, sourceFails = true, candidateCalls = 0, sourceCalls = 0
  const nine = ['outline','synopsis','world','structure','hooks','foreshadowing','reversals','constraints','episode_outline'].map(key => ({ key, content: key === 'outline' ? sources[0]!.content : `完整${key}正确正文。` }))
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) { if (sourceFails) throw Object.assign(new Error('known terminal source protocol mismatch'), { delivery: 'rejected' }); return JSON.stringify({ summary: '无需修改', source_edits: [] }) }
    candidateCalls++; return JSON.stringify({ summary: '核对完整正文', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: nine, steps: steps(), generate }), /known terminal/)
  assert.equal(candidateCalls, 9)
  const before = structuredClone(checkpoint.steps)
  const upgraded: StructuredGenerator = async () => { sourceCalls++; return JSON.stringify({ summary: '只读核对完成', source_edits: [] }) }
  await generateScriptDraftRepairWorksets({ ...common(), sources: nine, steps: steps(), generate, generateSource: upgraded, sourceTransportIdentity: { transport: 'single-submit', version: 1, instruction: '只提交本次工具参数' } })
  assert.equal(candidateCalls, 9); assert.equal(sourceCalls, 1)
  for (const [id, value] of Object.entries(before).filter(([id]) => id === 'repair:worksets:decisions' || id.startsWith('repair:worksets:candidate:'))) assert.deepEqual(checkpoint.steps[id], value, 'every completed candidate and decision retains its exact hash/value')
  assert.ok(checkpoint.steps['repair:worksets:aggregate'])
  await generateScriptDraftRepairWorksets({ ...common(), sources: nine, steps: steps(), generate, generateSource: upgraded, sourceTransportIdentity: { transport: 'single-submit', version: 1, instruction: '只提交本次工具参数' } })
  assert.equal(sourceCalls, 1); assert.equal(candidateCalls, 9)
  await generateScriptDraftRepairWorksets({ ...common(), sources: nine, steps: steps(), generate, generateSource: upgraded, sourceTransportIdentity: { transport: 'single-submit', version: 2, instruction: '新的实际提交协议' } })
  assert.equal(sourceCalls, 2); assert.equal(candidateCalls, 9)
})


test('unknown source transport retains nine cached candidates and cannot produce an aggregate or source edits', async () => {
  const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
  let checkpoint: GenerationCheckpoint = { steps: {} }, candidateCalls = 0, calls = 0, validated = 0
  const nine = ['outline','synopsis','world','structure','hooks','foreshadowing','reversals','constraints','episode_outline'].map(key => ({ key, content: key === 'outline' ? sources[0]!.content : `完整${key}正确正文。` }))
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    if (contract!.name.endsWith('source')) throw new Error('source transport not selected')
    candidateCalls++; return JSON.stringify({ summary: '核对', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  const unknown = new TextProviderError('header timeout', true, 'headers_timeout'); unknown.delivery = 'unknown'
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: nine, steps: steps(), generate,
    generateSource: async () => { calls++; throw unknown }, sourceTransportIdentity: { mode: 'single-submit' }, validate: () => { validated++ } }), error => error === unknown)
  assert.equal(calls, 1); assert.equal(candidateCalls, 9); assert.equal(validated, 0)
  assert.equal(checkpoint.steps['repair:worksets:aggregate'], undefined)
  assert.equal(Object.keys(checkpoint.steps).filter(key => key.startsWith('repair:worksets:candidate:')).length, 9)
  assert.ok(!Object.keys(checkpoint.steps).some(key => key.startsWith('repair:worksets:source:')))
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), generate, generateSource: async () => assert.fail('missing identity never dispatches') }), /绑定实际/)
})


test('new protocol proposals bind the actual transport; changed transport cannot reuse them, and intact raw restores damaged business results', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  const generate: StructuredGenerator = async (prompt, contract) => {
    calls++
    if (contract!.name.endsWith('decisions')) return JSON.stringify(decisions)
    return JSON.stringify({ summary: '核对完成', edits: keyIn(prompt, 'outline') ? [edit] : [] })
  }
  await generateScriptDraftRepairWorksets({ ...common(), sourceReadOnly: true, steps: steps(), generate })
  assert.equal(calls, 4)
  let nativeCalls = 0
  const upgraded = () => ({ ...common(), sourceReadOnly: true, steps: steps(), generate: async () => assert.fail('old transport is never probed'),
    candidateTransportIdentity: { version: 1 }, generateCandidate: async (prompt: string) => {
      nativeCalls++; return JSON.stringify({ summary: '新通道', edits: keyIn(prompt, 'outline') ? [edit] : [] })
    } })
  await generateScriptDraftRepairWorksets(upgraded())
  assert.equal(nativeCalls, 3)
  const id = Object.keys(checkpoint.steps).find(id => id.startsWith('repair:worksets:candidate:') && (checkpoint.steps[id]!.value as any).edits[0]?.source_key === 'outline')!
  ;(checkpoint.steps[id]!.value as any).edits[0].find = '损坏业务缓存'
  await generateScriptDraftRepairWorksets(upgraded())
  assert.equal(nativeCalls, 3)
  assert.deepEqual((checkpoint.steps[id]!.value as any).edits, [edit])
})

test('candidate native unknown and caller conflict stop before aggregate adoption without a hidden legacy dispatch', async () => {
  const { TextProviderError } = await import('../src/infrastructure/providers/text-errors.js')
  const unknown = new TextProviderError('accepted response disconnected', true, 'connection_error'); unknown.delivery = 'unknown'
  let calls = 0, validated = 0
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: [sources[0]!], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision],
    generate: async () => assert.fail('no old native text call'), generateCandidate: async () => { calls++; throw unknown }, candidateTransportIdentity: { version: 1 }, validate: () => { validated++ } }), error => error === unknown)
  assert.equal(calls, 1); assert.equal(validated, 0)
  const conflict = Object.assign(new Error('candidate version changed'), { statusCode: 409 })
  let checkpoint: GenerationCheckpoint = { steps: {} }
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: [sources[0]!], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision],
    steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }), generate: async () => assert.fail('no old call'),
    generateCandidate: async () => JSON.stringify({ summary: '完整候选结果', edits: [edit] }), candidateTransportIdentity: { version: 1 }, validate: () => { throw conflict } }), error => error === conflict)
  assert.ok(Object.keys(checkpoint.steps).some(key => key.startsWith('repair:worksets:candidate:')))
  assert.equal(checkpoint.steps['repair:worksets:aggregate'], undefined)
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), generate: async () => assert.fail('no request'), generateCandidate: async () => assert.fail('missing identity never dispatches') }), /绑定实际/)
})

const frozenIn = (prompt: string) => JSON.parse(prompt.split('可替换来源（冻结段落原文）：')[1]!.split('\n')[0]!) as Array<{ source_key: string; parts: Array<string | [string, string]> }>

test('candidate local correction keeps valid siblings and requests only failed immutable targets across scene fields', async () => {
  const scene = [{ key: 'scene:0:action', content: '起身。\n\n离开。' }, { key: 'scene:0:dialogue', content: '甲：保留名字。' }]
  const kept = { source_key: scene[0]!.key, find: '起身。', replace: '起身并付出代价。', reason: '落实' }
  const failed = [kept, { source_key: scene[0]!.key, find: '不存在动作。', replace: '离开。', reason: '落实' },
    { source_key: scene[1]!.key, find: '不存在对白。', replace: '甲：代价是当日记忆。', reason: '落实' }]
  let calls = 0, validated = 0
  const result = await generateScriptDraftRepairWorksets({ ...common(), sources: scene, sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision],
    generate: async (prompt, contract) => {
      calls++
      if (calls === 1) return JSON.stringify({ summary: '初次提交', edits: failed })
      assert.equal(contract!.name, 'script_draft_workset_candidate_local_repair')
      assert.ok(!prompt.includes(base), 'full background is already bound; only necessary targets are corrected')
      assert.ok(prompt.includes(decisions.decisions[0]!.decision))
      const schema = contract!.schema as any
      assert.deepEqual(Object.keys(schema.properties.repairs.properties).sort(), ['edit_1', 'edit_2'])
      assert.match(prompt, /\$\.edits\[1\]/); assert.match(prompt, /\$\.edits\[2\]/)
      return JSON.stringify({ repairs: {
        edit_1: { source_key: scene[0]!.key, find: '离开。', replace: '离开并支付记忆。', reason: '落实' },
        edit_2: { source_key: scene[1]!.key, find: '甲：保留名字。', replace: '甲：代价是当日记忆。', reason: '落实' },
      } })
    }, validate: () => { validated++ } })
  assert.equal(calls, 2); assert.equal(result.edits.length, 3); assert.deepEqual(result.edits[0], kept); assert.ok(validated > 0)
})

test('repeated paragraphs have independent references; one invalid sibling is corrected without copying the valid proposal', async () => {
  const content = '重复。\n\n重复。\n\n独特：汉字🦊é。'
  let calls = 0, frozen: ReturnType<typeof frozenIn>
  const result = await generateScriptDraftRepairWorksets({ ...common(), sources: [{ key: 'outline', content }], sourceReadOnly: true,
    manualPlans: [decisions.decisions[0]!.decision], generate: async (prompt, contract) => {
      calls++
      if (calls === 1) {
        frozen = frozenIn(prompt)
        const parts = frozen[0]!.parts.filter(Array.isArray)
        assert.equal(parts.length, 3); assert.notEqual(parts[0]![0], parts[1]![0])
        return JSON.stringify({ summary: '修第二处重复段', edits: [
          { operation: 'replace_ref', source_key: 'outline', ref_id: parts[1]![0], replace: '重复但付出当日记忆。', reason: '只改第二处' },
          { source_key: 'outline', find: '独特汉字🦊é。', replace: '完整新值。', reason: '修独特段' },
        ] })
      }
      assert.equal(contract!.name, 'script_draft_workset_candidate_local_repair')
      const [ref_id, text] = frozen![0]!.parts.filter(Array.isArray)[2]!
      return JSON.stringify({ repairs: { edit_1: { operation: 'replace_ref', source_key: 'outline', ref_id, replace: text + '代价为当日记忆。', reason: '修独特段' } } })
    } })
  assert.equal(calls, 2); assert.ok(result.edits.every(edit => edit.paragraph_id && !edit.find))
  assert.notEqual(result.edits[0]!.paragraph_id, result.edits[1]!.paragraph_id)
})

test('candidate reference correction does not relax exact uniqueness, overlap, stale references or atomic adoption', async () => {
  for (const mode of ['ambiguous', 'overlap', 'stale_ref', 'foreign_ref'] as const) {
    let calls = 0, validated = 0, checkpoint: GenerationCheckpoint = { steps: {} }
    const content = '重复。\n\n重复。\n\n完整唯一原文。'
    let initialFrozen: ReturnType<typeof frozenIn>
    await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: [{ key: 'outline', content }], sourceReadOnly: true,
      manualPlans: [decisions.decisions[0]!.decision], steps: createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } }),
      generate: async prompt => {
        calls++
        let edits: any[]
        if (calls === 1) initialFrozen = frozenIn(prompt)
        if (mode === 'ambiguous') edits = [{ source_key: 'outline', find: '重复。', replace: '不得猜位置。', reason: '测试' }]
        else if (mode === 'overlap') edits = ['完整唯一原文。', '唯一原文'].map(find => ({ source_key: 'outline', find, replace: '不得部分采用。', reason: '测试' }))
        else {
          const [ref_id] = initialFrozen![0]!.parts.find(Array.isArray) as [string, string]
          edits = [{ operation: 'replace_ref', source_key: mode === 'foreign_ref' ? 'world' : 'outline', ref_id: mode === 'stale_ref' ? 'r:' + '0'.repeat(24) : ref_id, replace: '不得采用。', reason: '测试' }]
        }
        return JSON.stringify({ summary: '不允许绕过校验', edits })
      }, validate: () => { validated++ } }), mode === 'ambiguous' ? /出现多次|ambiguous_passage/ : mode === 'overlap' ? /重叠/ : /不属于|必须|符合|source_key/)
    assert.equal(calls, 2, mode); assert.equal(validated, 0, mode)
    assert.equal(checkpoint.steps['repair:worksets:aggregate'], undefined)
    assert.ok(!Object.keys(checkpoint.steps).some(key => key.startsWith('repair:worksets:candidate:')), mode)
  }
})

test('locator diagnostics preserve six legacy and one native reversal cache with 60 edits; only two misses dispatch', async () => {
  const keys = ['outline','synopsis','world','structure','hooks','foreshadowing','reversals','constraints','episode_outline']
  const counts = [5,5,5,5,5,4,31,2,2]
  const nine = keys.map((key,index) => ({ key, content: Array.from({ length: counts[index]! }, (_, n) => `${key}原段${n}。`).join('\n\n') }))
  const cached = (key: string) => ({ summary: `缓存${key}`, edits: nine.find(source => source.key === key)!.content.split('\n\n').map(find => ({ source_key: key, find, replace: find + '已落实。', reason: '落实作者方案' })) })
  // Captured from the unmodified workset implementation, with six legacy
  // children plus a 31-edit native replace_ref reversal already normalized.
  const historical = [
    ['891fd2cc6964c9d3263b7b9d', '34acb2f2c6bbc8ac62b076f02fc3aad906b3ce237277647660c7c4d41c1da437'],
    ['f5dbab68fd7bf702c8068ba1', '369c09a9002b06c2d41182f351ebf47ac65c249f48a60239d8730aaccb3cb37f'],
    ['09bf524dc6f5272161e2c2fc', '36de827358f81680d909652a64c7b1f97dc2c0f7246b691e56d99a8a9b2a8ca6'],
    ['0afc75935d8f29003564553e', '6fe35f9307434120128cd63cf5c04e4d42a264d300f87a78ba3802339435392c'],
    ['95f591e6fee2923439d17a7c', '531fde5010c9f06b749dd5311e0fb9d00e787861bbe34cb513f0ebfcb9d1b048'],
    ['ec7a2efb9951bd01f50b2ed0', 'c875291674ef959607a74211e905b77415d5fa0161aa8e5a5211a7603508f426'],
    ['0e70e91f759559665e58cb3b', '13dc752fb0e2a17939b14c6e0df9597a9cdf723ccffd5d21b14d2daf1247614c'],
  ]
  let checkpoint: GenerationCheckpoint = { steps: { 'repair:worksets:decisions': {
    input_hash: '694fa717804cc96bc7ed31eb407c52507295d973f4d2849cd396f4e3e6434782', value: decisions, duration_ms: 1,
  }, ...Object.fromEntries(historical.map(([suffix, input_hash], index) => [`repair:worksets:candidate:${suffix}`, { input_hash, value: cached(keys[index]!), duration_ms: 100 + index }])) } }
  const before = structuredClone(checkpoint.steps)
  assert.equal(Object.values(before).reduce((count, item) => count + ((item.value as any).edits?.length || 0), 0), 60)
  const dispatched: string[] = []
  const options = () => ({ ...common(), prompt: '旧缓存兼容：全部原稿和作者反馈。', sources: nine, currentSource: undefined, sourceReadOnly: true,
    manualPlans: [decisions.decisions[0]!.decision], steps: createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } }),
    generate: async () => assert.fail('legacy transport must never dispatch'),
    generateCandidate: async (prompt: string) => { const key = frozenIn(prompt)[0]!.source_key; dispatched.push(key); return JSON.stringify(cached(key)) },
    candidateTransportIdentity: { version: 1, instruction: '完整实际提交协议', name: 'submit_draft_repair' } })
  const result = await generateScriptDraftRepairWorksets(options())
  assert.deepEqual(dispatched.sort(), ['constraints', 'episode_outline'])
  assert.equal(result.edits.length, 64)
  for (const [id, retained] of Object.entries(before)) assert.deepEqual(checkpoint.steps[id], retained, 'hash, canonical edits and duration all remain byte-equivalent')
  await generateScriptDraftRepairWorksets(options())
  assert.equal(dispatched.length, 2, 'all nine completed children subsequently reuse without requests')
})


test('failed full proposal and the consumed correction survive restart without purchasing either response again', async () => {
  let durable: GenerationCheckpoint = { steps: {} }, calls = 0, applied = 0
  const steps = () => createGenerationSteps({ checkpoint: structuredClone(durable), save: state => { durable = structuredClone(state) } })
  const options = () => ({ ...common(), sources: [sources[0]!], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision], steps: steps(), validate: () => { applied++ } })
  const invalid = { ...edit, find: '不存在的精确片段' }
  await assert.rejects(generateScriptDraftRepairWorksets({ ...options(), generate: async (_text, contract) => {
    calls++
    return JSON.stringify(contract!.name.endsWith('_local_repair') ? { repairs: { edit_0: invalid } } : { summary: '保留的完整提案', edits: [invalid] })
  } }), /已修正一次/)
  assert.equal(calls, 2); assert.equal(applied, 0)
  const proposal = Object.values(durable.steps).find(step => (step.value as any).proposal_state)!.value as any
  assert.ok(proposal.raw && proposal.correction.raw && proposal.correction_started)
  assert.deepEqual(proposal.proposal_state.retained_indices, [])
  await assert.rejects(generateScriptDraftRepairWorksets({ ...options(), generate: async () => assert.fail('a restored failed correction may not dispatch') }), /已修正一次/)
  assert.equal(calls, 2); assert.equal(applied, 0); assert.equal(durable.steps['repair:worksets:aggregate'], undefined)
})

test('unknown local correction is durably exhausted and cannot resend on continuation', async () => {
  let checkpoint: GenerationCheckpoint = { steps: {} }, calls = 0
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  const options = () => ({ ...common(), sources: [sources[0]!], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision], steps: steps() })
  const unknown = Object.assign(new Error('accepted local correction disconnected'), { delivery: 'unknown', retryable: false })
  await assert.rejects(generateScriptDraftRepairWorksets({ ...options(), generate: async (_prompt, contract) => {
    calls++; if (contract!.name.endsWith('_local_repair')) throw unknown
    return JSON.stringify({ summary: '已取得的初始提案', edits: [{ ...edit, find: '不存在' }] })
  } }), error => error === unknown)
  assert.equal(calls, 2)
  await assert.rejects(generateScriptDraftRepairWorksets({ ...options(), generate: async () => assert.fail('unknown must pause, not replay') }), error => (error as any).code === 'structured_correction_exhausted')
  assert.equal(calls, 2)
})

test('source-only workset corrects one failed target while preserving the valid sibling and exact whitespace', async () => {
  const manuscript = '保留：汉字🦊é。\r\n\r\n需修：原段。'
  const kept = { find: '保留：汉字🦊é。', replace: '保留：汉字🦊é，明确约束。', reason: '必要同步' }
  let calls = 0
  const result = await generateScriptDraftRepairWorksets({ ...common(), sources: [], currentSource: manuscript, manualPlans: [decisions.decisions[0]!.decision], generate: async (prompt, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ summary: '必要原稿同步', source_edits: [kept, { find: '错引原段', replace: '需修：明确新值。', reason: '必要同步' }] })
    assert.equal(contract!.name, 'script_draft_workset_source_local_repair')
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['edit_1'])
    assert.ok(!prompt.includes(base))
    return JSON.stringify({ repairs: { edit_1: { find: '需修：原段。', replace: '需修：明确新值。', reason: '必要同步' } } })
  } })
  assert.equal(calls, 2); assert.deepEqual(result.source_edits[0], kept); assert.deepEqual(result.edits, [])
})

test('invalid source keys and conflict groups receive legal frozen targets without granting arbitrary edits', async () => {
  for (const mode of ['foreign-source', 'overlap'] as const) {
    let calls = 0
    const content = '第一段。\n\n第二段。'
    const result = await generateScriptDraftRepairWorksets({ ...common(), sources: [{ key: 'outline', content }], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision], generate: async (prompt, contract) => {
      calls++
      if (calls === 1) return JSON.stringify({ summary: '初始待校验', edits: mode === 'foreign-source'
        ? [{ source_key: 'not-authorized', find: '第一段。', replace: '修订一。', reason: '落实' }]
        : [{ source_key: 'outline', find: '第一段。', replace: '修订一。', reason: '落实' }, { source_key: 'outline', find: '一段', replace: '修订二。', reason: '落实' }] })
      assert.equal(contract!.name, 'script_draft_workset_candidate_local_repair')
      assert.ok(prompt.includes('第一段。') && prompt.includes('第二段。'))
      const keys = Object.keys((contract!.schema.properties as any).repairs.properties)
      assert.deepEqual(keys, mode === 'overlap' ? ['group_0_1'] : ['edit_0'])
      return JSON.stringify({ repairs: mode === 'overlap' ? { group_0_1: { replace: '合并修订一和二。', reason: '落实两项合并' } } : { edit_0: { source_key: 'outline', find: '第一段。', replace: '修订一。', reason: '落实' } } })
    } })
    assert.equal(calls, 2); assert.equal(result.edits.length, 1)
  }
})


test('two whole-paragraph conflicts consolidate into one covering edit while nine valid proposals stay exact', async () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `原段${index}。`), content = paragraphs.join('\r\n\r\n')
  const kept = paragraphs.slice(1).map(find => ({ source_key: 'outline', find, replace: find + '必要补充。', reason: '落实对应项' }))
  let calls = 0
  const result = await generateScriptDraftRepairWorksets({ ...common(), sources: [{ key: 'outline', content }], sourceReadOnly: true, manualPlans: [decisions.decisions[0]!.decision], generate: async (_prompt, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ summary: '完整初始提案', edits: [
      { source_key: 'outline', find: paragraphs[0], replace: '原段0，修改甲。', reason: '甲方案' },
      ...kept,
      { source_key: 'outline', find: paragraphs[0], replace: '原段0，修改乙。', reason: '乙方案' },
    ] })
    assert.equal(contract!.name, 'script_draft_workset_candidate_local_repair')
    assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['group_0_10'])
    return JSON.stringify({ repairs: { group_0_10: { replace: '原段0，合并甲乙方案。', reason: '同时落实两个修订' } } })
  } })
  assert.equal(calls, 2); assert.equal(result.edits.length, 10); assert.deepEqual(result.edits.slice(1), kept)
})

test('a conflict merger cannot discard a required range or rewrite an independent valid sibling', async () => {
  let calls = 0, adopted = 0
  await assert.rejects(generateScriptDraftRepairWorksets({ ...common(), sources: [{ key: 'outline', content: '甲乙丙丁。\n\n独立正确段。' }], sourceReadOnly: true,
    manualPlans: [decisions.decisions[0]!.decision], validate: () => { adopted++ }, generate: async (_prompt, contract) => {
      calls++
      if (calls === 1) return JSON.stringify({ summary: '原提案', edits: [
        { source_key: 'outline', find: '甲乙丙', replace: '修改甲乙丙', reason: '甲要求' },
        { source_key: 'outline', find: '乙丙丁', replace: '修改乙丙丁', reason: '乙要求' },
        { source_key: 'outline', find: '独立正确段。', replace: '独立必要修改。', reason: '独立项' },
      ] })
      assert.deepEqual(Object.keys((contract!.schema.properties as any).repairs.properties), ['group_0_1'])
      return JSON.stringify({ repairs: { group_0_1: { source_key: 'outline', find: '甲乙', replace: '非法自选范围', reason: '非法删减' } } })
    } }), /符合|多余|未定义|Unrecognized|unrecognized/)
  assert.equal(calls, 2); assert.equal(adopted, 0)
})
