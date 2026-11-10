import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { beginTextRequest, createScriptRequestUsage, TextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'
import { ReviewPaginationStalledError } from '../src/modules/script/script-review-pagination.js'
import { modelAttemptNumber } from '../src/modules/generation/model-execution.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import { createGenerationSteps, type GenerationCheckpoint, type GenerationStepEvent } from '../src/modules/script/script-generation-steps.js'

const directory = await mkdtemp(join(tmpdir(), 'draft-repair-generation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'repair fixtures must never open the workspace database')
const { createScriptDraftRepairOutputSchema, createScriptDraftRepairDecisionsSchema, generateScriptDraftRepairOutput } =
  await import('../src/modules/script/script-draft-repair-generation.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

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
    return text({ items: [], complete: true })
  }, { steps: f.steps() })
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
    await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      resumed.push(stage(contract))
      return text(stage(contract) === '_decisions' ? { decisions } : edits())
    }, { steps: f.steps() })
    assert.deepEqual(resumed, ['_decisions', '_edits'])
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
  await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    resumed.push(stage(contract)); return text(edits())
  }, { steps: f.steps(), validate })
  assert.deepEqual(resumed, ['_edits'])
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
    assert.deepEqual(f.checkpoint().steps, {})
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
  const f = fixture(), controller = new AbortController(), reason = new Error('用户停止补齐'), calls: string[] = []
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

test('revalidated changed decisions invalidate patch inputs and cannot be hidden by the older aggregate', async () => {
  const f = fixture()
  await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
    if (stage(contract) === 'whole') throw outputLimit()
    return text(stage(contract) === '_decisions' ? { decisions } : edits())
  }, { steps: f.steps() })
  const checkpoint = f.checkpoint()
  ;(checkpoint.steps['repair:decisions']!.value as { decisions: unknown[] }).decisions = []
  f.save(checkpoint)
  const revised = decisions.map(item => ({ ...item, decision: item.decision + '并保留新增的因果条件' })), calls: string[] = []
  const result = await generateScriptDraftRepairOutput(prompt, ids, async (sent, contract) => {
    calls.push(stage(contract))
    if (stage(contract) === '_decisions') return text({ decisions: revised })
    assert.ok(sent.includes(`本次已确定具体决定：${JSON.stringify(revised)}`))
    return text({ ...edits(), summary: '真正落实更新后的全部决定' })
  }, { steps: f.steps() })
  assert.deepEqual(calls, ['_decisions', '_edits'])
  assert.deepEqual(result.decisions, revised.map(item => item.decision))
  assert.equal(result.summary, '真正落实更新后的全部决定')
  assert.deepEqual(f.checkpoint().steps.repair!.value, result)
})

test('a failed replacement of a damaged recovery child removes the obsolete complete aggregate before dispatch', async t => {
  for (const child of ['repair:decisions', 'repair:edits']) await t.test(child, async () => {
    const f = fixture()
    await generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      if (stage(contract) === 'whole') throw outputLimit()
      return text(stage(contract) === '_decisions' ? { decisions } : edits())
    }, { steps: f.steps() })
    const checkpoint = f.checkpoint()
    assert.equal(has(checkpoint, 'repair'), true)
    checkpoint.steps[child]!.value = {}
    f.save(checkpoint)
    const calls: string[] = [], failure = outputLimit()
    await assert.rejects(generateScriptDraftRepairOutput(prompt, ids, async (_sent, contract) => {
      calls.push(stage(contract))
      assert.equal(has(f.checkpoint(), 'repair'), false, 'false complete progress is removed durably before replacing the child')
      throw failure
    }, { steps: f.steps() }), issue => issue === failure || issue instanceof ReviewPaginationStalledError && issue.cause === failure)
    const name = child === 'repair:decisions' ? '_decisions' : '_edits'
    assert.deepEqual(calls, [name, ...Array(4).fill(name + '_page')])
    assert.equal(has(f.checkpoint(), 'repair'), false)
    assert.equal(has(f.checkpoint(), 'repair:recovery'), true)
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
