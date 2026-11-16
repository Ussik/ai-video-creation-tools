import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const directory = await mkdtemp(join(tmpdir(), 'conflict-group-authority-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'))
const { generateScriptDraftRepairWorksets } = await import('../src/modules/script/script-draft-repair-worksets.js')
const { createGenerationSteps } = await import('../src/modules/script/script-generation-steps.js')
const { createDraftRepairReferences } = await import('../src/modules/script/script-draft-repair-references.js')
const { applyResolvedEdits } = await import('../src/modules/script/script-revision.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const identity = { candidate_id: 'same-candidate', candidate_version: 'same-version', source_version: 'same-source' }
const base = { prompt: '完整作者方案、原文、反馈及历史保持。仅修复固定问题，其他事实保留。', issueIds: ['issue'], sourceReadOnly: true,
  referenceIdentity: identity, executionIdentity: { model: 'same-model', provider: 'same-provider' }, manualPlans: ['合并甲乙修订，同时保留已合法的独立丙项。'],
  candidateTransportIdentity: { version: 1, transport: 'anthropic_single_submit' }, generate: async () => assert.fail('legacy request is not allowed') }
const frozen = (prompt: string) => JSON.parse(prompt.split('可替换来源（冻结段落原文）：')[1]!.split('\n')[0]!) as Array<{ source_key: string; parts: Array<string | [string, string]> }>
const render = (content: string, edits: any[]) => applyResolvedEdits(content, createDraftRepairReferences([{ key: 'outline', content }], identity).resolveEdits('outline', edits))

for (const sourceOnly of [false, true]) test(`${sourceOnly ? 'source' : 'candidate'} duplicate-paragraph conflict merges only the second immutable paragraph and retains the independent valid sibling`, async () => {
  const repeated = '重复甲乙🦊。', keep = '保留独立事实。'
  const content = repeated + '\r\n\r\n' + keep + '\r\n\r\n' + repeated
  const replacement = '重复甲乙🦊并完整合并甲乙两项修订。'
  const sibling = { ...(sourceOnly ? {} : { source_key: 'outline' }), find: keep, replace: '保留独立事实并落实丙项。', reason: '独立合法操作原样保留' }
  let calls = 0, originalRef = ''
  const generate = async (prompt: string, contract?: { name: string }) => {
    calls++
    if (calls === 1) {
      const document = frozen(prompt)[0]!
      const matches = document.parts.filter((part): part is [string, string] => Array.isArray(part) && part[1] === repeated)
      assert.equal(matches.length, 2); originalRef = matches[1]![0]
      const ref = { operation: 'replace_ref', ...(sourceOnly ? {} : { source_key: 'outline' }), ref_id: originalRef }
      return JSON.stringify({ summary: '冻结完整初始提案', [sourceOnly ? 'source_edits' : 'edits']: [
        { ...ref, replace: '重复甲乙🦊落实甲项。', reason: '甲项' }, { ...ref, replace: '重复甲乙🦊落实乙项。', reason: '乙项' }, sibling] })
    }
    assert.ok(contract!.name.endsWith('_local_repair'))
    assert.ok(prompt.includes('group_0_1')); assert.ok(prompt.includes(originalRef))
    return JSON.stringify({ repairs: { group_0_1: { replace: replacement, reason: '同处合并甲乙，保留范围外内容' } } })
  }
  const result = await generateScriptDraftRepairWorksets({ ...base, sourceReadOnly: !sourceOnly,
    sources: sourceOnly ? [] : [{ key: 'outline', content }], currentSource: sourceOnly ? content : undefined,
    ...(sourceOnly ? { generateSource: generate, sourceTransportIdentity: { version: 1, transport: 'anthropic_single_submit' } } : { generateCandidate: generate }),
    validate: () => {} })
  const edits = sourceOnly ? result.source_edits : result.edits
  assert.equal(calls, 2); assert.equal(edits.length, 2)
  assert.deepEqual(edits[1], sibling)
  assert.ok('paragraph_id' in edits[0]!, 'repeated text must retain its fixed paragraph identity')
  assert.ok(!('find' in edits[0]!)); assert.ok(!sourceOnly || !('source_key' in edits[0]!))
  const refs = createDraftRepairReferences([{ key: sourceOnly ? 'script-source' : 'outline', content }], identity)
  const key = sourceOnly ? 'script-source' : 'outline'
  const changes = refs.resolveEdits(key, edits.map(edit => ({ ...edit, source_key: key })))
  assert.equal(applyResolvedEdits(content, changes), repeated + '\r\n\r\n' + sibling.replace + '\r\n\r\n' + replacement)
})

test('transitively overlapping unique spans merge at the exact program-owned union and preserve all surrounding Unicode and valid siblings', async () => {
  const union = 'ABCDE🦊FGHIJ', content = '前缀不变|' + union + '|尾部不变。\n\n独立事实。'
  const sibling = { source_key: 'outline', find: '独立事实。', replace: '独立事实并落实丙项。', reason: '保留合法兄弟提案' }
  let calls = 0
  const result = await generateScriptDraftRepairWorksets({ ...base, sources: [{ key: 'outline', content }], generateCandidate: async (_prompt, contract) => {
    calls++
    if (calls === 1) return JSON.stringify({ summary: '完整初始提案', edits: [
      ...['ABC', 'CDE🦊F', 'FGHIJ'].map((find, index) => ({ source_key: 'outline', find, replace: `修订${index}。`, reason: '当前冲突组' })), sibling] })
    assert.ok(contract!.name.endsWith('_local_repair'))
    return JSON.stringify({ repairs: { group_0_1_2: { replace: '甲乙丙🦊合并后内容', reason: '合并传递冲突，范围由程序持有' } } })
  }, validate: () => {} })
  assert.equal(calls, 2); assert.equal(result.edits.length, 2)
  assert.equal(result.edits[0]!.find, union, 'merged locator is exactly the trusted union, never the full paragraph')
  assert.deepEqual(result.edits[1], sibling)
  assert.equal(render(content, result.edits), '前缀不变|甲乙丙🦊合并后内容|尾部不变。\n\n' + sibling.replace)
})

test('conflict correction cannot supply or widen coordinates, add groups or omit a required group; failures retain the full proposal and cannot buy a third attempt', async t => {
  const content = '前缀不变|ABCDE🦊FGHIJ|尾部不变。\n\n独立事实。'
  const sibling = { source_key: 'outline', find: '独立事实。', replace: '独立事实并落实丙项。', reason: '合法兄弟提案' }
  const valid = { replace: '甲乙合并🦊内容', reason: '合并固定范围' }
  const cases: Array<[string, unknown]> = [
    ['source_key', { repairs: { group_0_1: { ...valid, source_key: 'outline' } } }],
    ['widened find', { repairs: { group_0_1: { ...valid, find: content } } }],
    ['paragraph_id', { repairs: { group_0_1: { ...valid, paragraph_id: 'invented' } } }],
    ['offset', { repairs: { group_0_1: { ...valid, offset: 0, start: 0, end: content.length } } }],
    ['extra group', { repairs: { group_0_1: valid, group_2: valid } }],
    ['missing required group', { repairs: {} }],
    ['old arbitrary operation array', { repairs: { group_0_1: [{ source_key: 'outline', find: content, ...valid }] } }],
  ]
  for (const [name, correction] of cases) await t.test(name, async () => {
    let durable: GenerationCheckpoint = { steps: {} }, calls = 0, adopted = 0
    const options = () => ({ ...base, sources: [{ key: 'outline', content }],
      steps: createGenerationSteps({ checkpoint: JSON.parse(JSON.stringify(durable)), save: value => { durable = JSON.parse(JSON.stringify(value)) } }),
      generateCandidate: async () => {
        calls++
        return calls === 1 ? JSON.stringify({ summary: '必须保留的完整初始提案', edits: [
          ...['ABC', 'CDE🦊F'].map(find => ({ source_key: 'outline', find, replace: '原始待合并内容。', reason: '当前冲突组' })), sibling] }) : JSON.stringify(correction)
      }, validate: () => { adopted++ } })
    await assert.rejects(generateScriptDraftRepairWorksets(options()))
    assert.equal(calls, 2); assert.equal(adopted, 0)
    assert.equal(durable.steps['repair:worksets:aggregate'], undefined)
    assert.ok(!Object.keys(durable.steps).some(id => id.startsWith('repair:worksets:candidate:')))
    const proposal = Object.values(durable.steps).map(step => step.value as any).find(value => value.proposal_state)
    assert.equal(JSON.parse(proposal.raw).edits.length, 3); assert.deepEqual(JSON.parse(proposal.raw).edits[2], sibling)
    assert.equal(proposal.correction.raw, JSON.stringify(correction))
    durable = JSON.parse(JSON.stringify(durable))
    await assert.rejects(generateScriptDraftRepairWorksets({ ...options(), generateCandidate: async () => assert.fail('consumed correction cannot dispatch again') }))
    assert.equal(calls, 2); assert.equal(adopted, 0)
  })
})
