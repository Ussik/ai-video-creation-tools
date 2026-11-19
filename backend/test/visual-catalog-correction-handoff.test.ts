import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, nativeOutputContractPrompt, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { visualCatalogLocalRepair, validateVisualCatalogIdentity } from '../src/modules/visuals/visual-profile-catalog.js'

const scene = '49b697d792ea4560892bcdb9516a9d24'
const item = z.object({ draft_key: z.string().min(1), kind: z.enum(['character', 'location', 'prop']), name: z.string().min(1),
  variant: z.string().default('默认'), scene_ids: z.array(z.enum([scene])).min(1), base_profile_id: z.string().nullable().optional(),
  base_draft_key: z.string().nullable().optional(), state_delta: z.string().optional() }).strict()
const schema = z.object({ profiles: z.array(item).max(100) }).strict()
const planner = visualCatalogLocalRepair({ itemSchema: item, schema, sceneIds: [scene], evidence: '当前一场五镜及实际出镜证据', constraints: '只依据实际出镜；木牌仅被提及，不能虚构出镜。' })
const dialect = Array.from({ length: 8 }, (_, index) => ({ draft_key: `object_${index}`, category: index < 2 ? 'character' : 'prop',
  name_zh: `对象${index}`, name_en: null, prompt_names: `对象${index}`, base_profile_id: null,
  base_draft_key: index === 1 ? 'object_0' : null, state_delta: index === 1 ? '仅右手背少量泥点' : null,
  definition: index === 2 ? '门上写着“暂停营业”，不能据此创造新对象。' : `固定外观${index}`, scene_ids: [scene] }))
const raw = '```json\n' + JSON.stringify({ profiles: dialect }, null, 2).replace('“暂停营业”', '"暂停营业"') + '\n```'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function patchFor(contract: any) {
  const values: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(contract.schema.properties.repairs.properties) as Array<[string, any]>) {
    if (key.endsWith('_remove_fields')) { values[key] = value.prefixItems.map((field: any) => field.const); continue }
    if (key.endsWith('_fields')) {
      const index = Number(key.split('_')[1]), d = dialect[index]!
      values[key] = Object.fromEntries(Object.keys(value.properties).map(field => [field, field === 'kind' ? d.category : d.name_zh]))
    } else if (key.endsWith('_remove_fields')) values[key] = value.prefixItems.map((field: any) => field.const)
    else throw new Error(`unexpected target ${key}`)
  }
  return { repairs: values, remove_root_fields: [] }
}
async function execute(original: string, checkpoint: StructuredOutputCheckpoint = {}, patch?: (contract: any) => unknown) {
  const calls: string[] = [], snapshots: any[] = []
  const result = await generateStructuredOutput('visual_profile_catalog', schema, async (_prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'visual_profile_catalog') return original
    assert.equal(contract!.name, 'visual_profile_catalog_local_repair')
    return JSON.stringify(patch ? patch(contract) : patchFor(contract))
  }, '只生成本场目录，最终Schema优先。', { checkpoint, freezeCorrection: true, preserveInputIdentity: true,
    localRepairOnly: true, localSyntaxOnly: true, planLocalRepair: planner,
    persistCheckpoint: () => snapshots.push(structuredClone(checkpoint)), validate: value => validateVisualCatalogIdentity(value.profiles, []) })
  return { result, calls, snapshots, checkpoint }
}

test('dccd fenced eight-item dialect with recovered quote reaches one field correction and retains original, scope and base relations', async () => {
  const cp: StructuredOutputCheckpoint = {}
  const first = await execute(raw, cp)
  assert.deepEqual(first.calls, ['visual_profile_catalog', 'visual_profile_catalog_local_repair'])
  assert.equal(first.result.profiles.length, 8)
  assert.equal(cp.original_raw, raw)
  assert.deepEqual(JSON.parse(cp.raw!), first.result)
  const candidate = (cp as any).correction_candidate
  assert.equal(candidate.raw_hash, digest(raw))
  assert.equal(candidate.candidate.profiles[2].definition, '门上写着"暂停营业"，不能据此创造新对象。')
  assert.ok(candidate.escape_offsets.length > 0)
  assert.ok(first.snapshots.some(saved => saved.correction_candidate && !saved.correction_started))
  for (let index = 0; index < 8; index++) {
    assert.deepEqual(first.result.profiles[index]!.scene_ids, [scene])
    assert.equal(first.result.profiles[index]!.base_draft_key, dialect[index]!.base_draft_key)
  }
  assert.equal(first.result.profiles[1]!.state_delta, dialect[1]!.state_delta)
  const replay = await execute(raw, JSON.parse(JSON.stringify(cp)))
  assert.equal(replay.calls.length, 0, 'completed correction cannot dispatch again after restart')
  assert.deepEqual(replay.result, first.result)
})

test('dccd actual private original is replayable through the same correction handoff without a network provider', { skip: !process.env.CANVAS_DCCD_ORIGINAL }, async () => {
  const original = readFileSync(process.env.CANVAS_DCCD_ORIGINAL!, 'utf8')
  let correctionCalls = 0
  const cp: StructuredOutputCheckpoint = {}
  const result = await execute(original, cp, contract => {
    correctionCalls++
    const repairs: Record<string, unknown> = {}
    const retained = (cp as any).correction_candidate.candidate.profiles
    for (const [key, value] of Object.entries(contract.schema.properties.repairs.properties) as Array<[string, any]>) {
      const entry = retained[Number(key.split('_')[1])]
      if (key.endsWith('_remove_fields')) repairs[key] = value.prefixItems.map((field: any) => field.const)
      else repairs[key] = Object.fromEntries(Object.keys(value.properties).map(field => [field, field === 'kind' ? entry.category : entry.name_zh]))
    }
    return { repairs, remove_root_fields: [] }
  })
  assert.equal(result.result.profiles.length, 8)
  assert.ok(result.result.profiles.every(profile => profile.scene_ids.length === 1 && profile.scene_ids[0] === scene))
  assert.equal(correctionCalls, 1)
  assert.equal(cp.original_raw, original)
  assert.equal((cp as any).correction_candidate.candidate.profiles.length, 8)
})

test('dccd valid association, base state and valid siblings cannot be rewritten in a field correction', async () => {
  const sibling = { draft_key: 'base', kind: 'character', name: '已确认人物', variant: '默认', scene_ids: [scene] }
  const invalid = { draft_key: 'mud', kind: 'character', name_zh: '已确认人物', variant: '手背泥点', scene_ids: [scene], base_draft_key: 'base', state_delta: '仅右手背泥点' }
  const parsed = schema.safeParse({ profiles: [sibling, invalid] }); assert.equal(parsed.success, false)
  const plan = planner({ profiles: [sibling, invalid] }, { issues: parsed.error!.issues })!
  assert.ok(plan)
  const contract = z.toJSONSchema(plan.schema) as any
  assert.deepEqual(Object.keys(contract.properties.repairs.properties.item_1_fields.properties), ['name'])
  const patch = { repairs: { item_1_fields: { name: '已确认人物' }, item_1_remove_fields: ['name_zh'] }, remove_root_fields: [] }
  const merged = plan.apply(patch) as any
  assert.deepEqual(merged.profiles[0], sibling)
  const { name_zh: _alias, ...retained } = invalid
  assert.deepEqual(merged.profiles[1], { ...retained, name: '已确认人物' })
  assert.throws(() => plan.apply({ ...patch, repairs: { ...patch.repairs, item_1_fields: { name: '已确认人物', scene_ids: ['foreign'] } } }))
})

test('dccd nested, truncated, multi-root and duplicate-key candidates never gain a correction or acceptance', async () => {
  const valid = JSON.stringify({ profiles: [{ draft_key: 'p', kind: 'prop', name: '铜钥匙', scene_ids: [scene] }] })
  for (const bad of ['{"wrapper":' + valid + '}', valid.slice(0, -1), valid + '\n' + valid, '```json\n' + valid, '{"profiles":[],"profiles":[]}', raw + '\n' + raw, raw.replace('\"暂停营业\"', '\"暂停\":\"营业\"')]) {
    const calls: string[] = []
    await assert.rejects(generateStructuredOutput('visual_profile_catalog', schema, async (_text, contract) => {
      calls.push(contract!.name); return bad
    }, '本次一场五镜目录', { localRepairOnly: true, localSyntaxOnly: true, planLocalRepair: planner }))
    assert.deepEqual(calls, ['visual_profile_catalog'])
  }
})

test('dccd conflicting canonical name and alias remains ambiguous rather than silently dropping evidence', async () => {
  const cp: StructuredOutputCheckpoint = {}
  await assert.rejects(execute(JSON.stringify({ profiles: [{ draft_key: 'p', kind: 'prop', name: '铜钥匙', name_zh: '另一把银钥匙', scene_ids: [scene] }] }), cp), /身份|歧义|冲突/)
  assert.equal(cp.correction_started, undefined)
})

test('dccd spent correction is preserved and never replaced by a new field planner', async () => {
  const cp: StructuredOutputCheckpoint = {}
  await assert.rejects(execute(raw, cp, () => ({ repairs: {}, remove_root_fields: [] })), (error: any) => {
    assert.ok(error.message.length < 180)
    assert.ok(!error.message.includes('$.profiles['))
    assert.equal(error.raw_output, raw)
    assert.ok(error.diagnostics.includes('$.profiles['))
    return true
  })
  const before = JSON.stringify(cp.correction)
  let calls = 0
  await assert.rejects(generateStructuredOutput('visual_profile_catalog', schema, async () => { calls++; throw new Error('must not dispatch') }, '只生成本场目录，最终Schema优先。', {
    checkpoint: JSON.parse(JSON.stringify(cp)), freezeCorrection: true, preserveInputIdentity: true, localRepairOnly: true, localSyntaxOnly: true, planLocalRepair: planner,
  }))
  assert.equal(calls, 0); assert.equal(JSON.stringify(cp.correction), before)
})

test('dccd native catalog contract explicitly scopes skill examples to creative method rather than their field dialect', async () => {
  let native = ''
  await generateStructuredOutput('visual_profile_catalog', schema, async (prompt, contract) => {
    native = nativeOutputContractPrompt(prompt, contract)
    return JSON.stringify({ profiles: [] })
  }, '【技能示例】category/name_zh/prompt_names/definition；这里只是参考。', { maxAttempts: 1 })
  assert.match(native, /kind.*name.*scene_ids/)
  assert.match(native, /技能.*(?:不能|不得).*字段/)
})


test('dccd unknown correction intent stays frozen and cannot dispatch another request', async () => {
  const cp: StructuredOutputCheckpoint = {}
  let calls = 0
  await assert.rejects(execute(raw, cp, () => { calls++; throw Object.assign(new Error('unknown correction delivery'), { statusCode: 409 }) }), /unknown correction delivery/)
  assert.equal(calls, 1)
  const saved = JSON.parse(JSON.stringify(cp)) as StructuredOutputCheckpoint
  let replayCalls = 0
  await assert.rejects(generateStructuredOutput('visual_profile_catalog', schema, async () => { replayCalls++; throw new Error('must not resend') }, '只生成本场目录，最终Schema优先。', {
    checkpoint: saved, freezeCorrection: true, preserveInputIdentity: true, localRepairOnly: true, localSyntaxOnly: true, planLocalRepair: planner,
  }))
  assert.equal(replayCalls, 0)
  assert.deepEqual(saved.correction_started, cp.correction_started)
  assert.deepEqual(saved.correction_request, cp.correction_request)
})
