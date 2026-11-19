import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { z } from 'zod'
import { ensureStoryboardOutlineQuality } from '../src/modules/storyboard/storyboard-outline-quality.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { storyboardValueSignature } from '../src/modules/storyboard/storyboard-review-scope.js'
const schema = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number(), scene_direction: z.object({}).passthrough(),
  shots: z.array(z.object({ shot_id: z.string().nullable(), duration: z.number(), prompt: z.string(), start_state: z.string(), end_state: z.string(), cut_note: z.string() }).passthrough()) }).passthrough()) }).passthrough()
const outline = () => ({ scenes: [{ scene_id: 'recheck-fixture', scene_duration: 35, scene_direction: {}, shots: Array.from({ length: 4 }, (_, i) => ({ shot_id: `shot-${i}`,
  duration: i === 3 ? 8 : 9, prompt: '动作' + i, start_state: '起点' + i, end_state: '终点' + i, cut_note: '接镜' + i })) }] })
const issue = () => ({ code: 'repeated_action', severity: 'error', scene_id: 'recheck-fixture', shot_index: 1, related_scene_id: 'recheck-fixture', related_shot_index: 0,
  message: '重复动作', evidence: '起点1', repair: '从终点开始', evidence_refs: [{ scene_id: 'recheck-fixture', shot_index: 1, field: 'start_state', quote: '起点1' }],
  repair_scope: [{ scene_id: 'recheck-fixture', shot_index: 1, operation: 'replace', fields: ['start_state'] }] })
function ledger(steps: Record<string, unknown> = {}) { const stages: string[] = []; return { steps, stages, signal: new AbortController().signal,
  stage(value: string) { stages.push(value) }, retain(key: string, value: unknown) { steps[key] = structuredClone(value) } } }
const opts = (original: ReturnType<typeof outline>, control: ReturnType<typeof ledger>, generate: any) => ({ outline: original, outlineKey: 'storyboard_batches:v1:initial:fixture:outline', schema, validate() {}, control,
  context: { storyboard_rules: 'LONG_RULE_SENTINEL'.repeat(5000), source_documents: 'SOURCE_SENTINEL'.repeat(5000) }, generate })

test('recheck unknown delivery preserves report and repair, records the right stage and blocks redispatch after restart', async () => {
  const original = outline(), control = ledger(), calls: string[] = []
  const generate = async (_prompt: string, contract: any) => {
    calls.push(contract.name)
    if (contract.name === 'storyboard_outline_repair') return JSON.stringify({ repairs: { field_0: '终点0，站定' } })
    if (calls.filter(name => name === 'storyboard_outline_review').length === 1) return JSON.stringify({ issues: [issue()] })
    throw new TextProviderError('模型接口连接中断，未获得完整响应。', true, 'connection_error')
  }
  await assert.rejects(ensureStoryboardOutlineQuality(opts(original, control, generate)), /未获得完整响应/)
  assert.equal(control.stages.at(-1), 'rechecking')
  const prefix = `storyboard_batches:v1:initial:fixture:outline:quality:v1:${storyboardValueSignature(original)}`
  const report = structuredClone(control.steps[prefix + ':report']), repaired = structuredClone(control.steps[prefix + ':repair'])
  const fresh = ledger(structuredClone(control.steps))
  await assert.rejects(ensureStoryboardOutlineQuality(opts(original, fresh, async () => assert.fail('unknown delivery must not redispatch'))), { code: 'structured_initial_delivery_pending' })
  assert.equal(fresh.stages.at(-1), 'rechecking')
  assert.deepEqual(fresh.steps[prefix + ':report'], report)
  assert.deepEqual(fresh.steps[prefix + ':repair'], repaired)
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_repair', 'storyboard_outline_review'])
})

test('retained report and repair resume only an unsent recheck with preserved facts and indexed evidence', async () => {
  const original = outline(), corrected = structuredClone(original), calls: string[] = []
  corrected.scenes[0]!.shots[1]!.start_state = '终点0，站定'
  const prefix = `storyboard_batches:v1:initial:fixture:outline:quality:v1:${storyboardValueSignature(original)}`
  const control = ledger({ [prefix + ':report']: { issues: [issue()] }, [prefix + ':repair']: corrected })
  const value = await ensureStoryboardOutlineQuality(opts(original, control, async (prompt: string, contract: any) => {
    calls.push(contract.name); assert.match(prompt, /终点0，站定/); assert.match(prompt, /outline_index|evidence_catalog/)
    return '{"issues":[]}'
  }))
  assert.deepEqual(value, corrected)
  assert.deepEqual(calls, ['storyboard_outline_review'])
  assert.equal(control.stages.at(-1), 'rechecking')
})

test('repair format correction omits huge unrelated context and keeps its own durable answer', async () => {
  const original = outline(), control = ledger(), calls: string[] = [], repairPrompts: string[] = []
  await ensureStoryboardOutlineQuality(opts(original, control, async (prompt: string, contract: any) => {
    calls.push(contract.name)
    if (contract.name === 'storyboard_outline_repair') {
      repairPrompts.push(prompt)
      return repairPrompts.length === 1 ? '{"repairs":{"field_0":null}}' : '{"repairs":{"field_0":"终点0，站定"}}'
    }
    return JSON.stringify({ issues: calls.length === 1 ? [issue()] : [] })
  }))
  assert.equal(repairPrompts.length, 2)
  assert.doesNotMatch(repairPrompts[1]!, /LONG_RULE_SENTINEL|SOURCE_SENTINEL/)
  assert.ok(repairPrompts[1]!.length < repairPrompts[0]!.length / 5)
  const saved = Object.entries(control.steps).find(([key]) => key.endsWith(':repair:structured_output:v1'))?.[1] as any
  assert.equal(saved.original_raw, '{"repairs":{"field_0":null}}')
  assert.equal(saved.correction.raw, '{"repairs":{"field_0":"终点0，站定"}}')
})

test('private incident checkpoints block pending recheck without changing paid outputs', { skip: !process.env.STORYBOARD_RECHECK_FIXTURE }, async () => {
  const fixture = JSON.parse(await readFile(process.env.STORYBOARD_RECHECK_FIXTURE!, 'utf8'))
  const outlineKey = Object.keys(fixture.steps).find(key => key.endsWith(':outline'))!
  const original = schema.parse(fixture.steps[outlineKey]), control = ledger(structuredClone(fixture.steps))
  const outputs = Object.fromEntries(Object.entries(control.steps).filter(([key]) => /:(?:outline|report|repair)$/.test(key)))
  await assert.rejects(ensureStoryboardOutlineQuality({ outline: original, outlineKey, schema, validate() {}, control, context: {},
    generate: async () => assert.fail('private replay cannot dispatch') }), { code: 'structured_initial_delivery_pending' })
  assert.equal(control.stages.at(-1), 'rechecking')
  for (const [key, value] of Object.entries(outputs)) assert.deepEqual(control.steps[key], value)
})

test('trusted not-sent delivery allows only the retained recheck to continue', async () => {
  const original = outline(), control = ledger(), calls: string[] = []
  let stopped = false
  const generate = async (_prompt: string, contract: any) => {
    calls.push(contract.name)
    if (contract.name === 'storyboard_outline_repair') return '{"repairs":{"field_0":"终点0，站定"}}'
    if (calls.length === 1) return JSON.stringify({ issues: [issue()] })
    if (!stopped) {
      stopped = true
      const error = new TextProviderError('请求尚未发送', false, 'connection_error')
      error.delivery = 'not_sent'; throw error
    }
    return '{"issues":[]}'
  }
  await assert.rejects(ensureStoryboardOutlineQuality(opts(original, control, generate)), /尚未发送/)
  const fresh = ledger(structuredClone(control.steps))
  await ensureStoryboardOutlineQuality(opts(original, fresh, generate))
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_repair', 'storyboard_outline_review', 'storyboard_outline_review'])
  assert.equal(fresh.stages.at(-1), 'rechecking')
})

test('recheck format correction keeps revised evidence and omits unrelated rules and source context', async () => {
  const original = outline(), corrected = structuredClone(original), prompts: string[] = []
  corrected.scenes[0]!.shots[1]!.start_state = '终点0，站定'
  const prefix = `storyboard_batches:v1:initial:fixture:outline:quality:v1:${storyboardValueSignature(original)}`
  const control = ledger({ [prefix + ':report']: { issues: [issue()] }, [prefix + ':repair']: corrected })
  await ensureStoryboardOutlineQuality(opts(original, control, async (prompt: string) => {
    prompts.push(prompt); return prompts.length === 1 ? '{"issues":null}' : '{"issues":[]}'
  }))
  assert.equal(prompts.length, 2)
  assert.match(prompts[0]!, /LONG_RULE_SENTINEL|SOURCE_SENTINEL/)
  assert.doesNotMatch(prompts[1]!, /LONG_RULE_SENTINEL|SOURCE_SENTINEL/)
  assert.match(prompts[1]!, /终点0，站定/)
  assert.ok(prompts[1]!.length < prompts[0]!.length / 5)
})

test('expansion markers do not leave completed outline reviews as the active failure stage', async () => {
  const { storyboardOutlineExecution, storyboardOutlineExecutionKey } = await import('../src/modules/storyboard/storyboard-outline-execution.js')
  const original = outline(), key = 'storyboard_batches:v1:initial:fixture:outline'
  assert.equal(storyboardOutlineExecution({ [key]: original, [storyboardOutlineExecutionKey]: { outline_key: key, stage: 'expanding' } }), undefined)
})
