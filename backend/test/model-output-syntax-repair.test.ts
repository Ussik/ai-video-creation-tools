import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { z } from 'zod'
import { generateStructuredOutput, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { proposeQuotedLineSyntax, quotedLineSyntaxRepair } from '../src/modules/generation/model-output-syntax-repair.js'
import { legacySourceMapSyntaxRepair as sourceMapSyntaxRepair } from '../src/modules/script/script-source-map-syntax-repair.js'
import { sourceMapSchema } from '../src/modules/script/script-source-map.js'

const raw = '```json\r\n{\r\n  "summary": "🦊实行"原创隔离"策略，保留否定：不是"替身"。",\r\n  "threads": [\r\n    "谁索要"心头血"？"\r\n  ]\r\n}\r\n```'
const schema = z.object({ summary: z.string(), threads: z.array(z.string()) }).strict()
const approval = () => ({ candidate_hash: createHash('sha256').update(raw).digest('hex'), approve: true })

test('frozen proposal inserts only backslashes at paired text quotes with exact UTF16 coordinates', () => {
  const p = proposeQuotedLineSyntax(raw)!
  assert.ok(p); assert.equal(p.audit.escape_offsets.length, 6)
  let restored = p.repairedRaw
  for (const [i, offset] of [...p.audit.escape_offsets.entries()].reverse()) {
    assert.equal(restored[offset + i], '\\')
    assert.equal(restored[offset + i + 1], '"')
    restored = restored.slice(0, offset + i) + restored.slice(offset + i + 1)
  }
  assert.equal(restored, raw)
  assert.deepEqual(p.value, { summary: '🦊实行"原创隔离"策略，保留否定：不是"替身"。', threads: ['谁索要"心头血"？'] })
  assert.equal(quotedLineSyntaxRepair(raw)!.apply(approval()) && raw.startsWith('```'), true)
})

test('ambiguous boundaries, mixed fields, odd quotes, unknown fields, invalid escapes and unfinished roots fail closed', () => {
  for (const text of ['{"summary":"good"}', '{\n "summary": "a", "name": "b"\n}', '{\n "summary": "abc"broken"\n}',
    '{\n "summary": "x"a":"b"c"\n}', '{\n "summary": "a"b", "c"d"\n}', '{\n "other": "a"b"c"\n}',
    '{\n "summary": "a"b"c\\q"\n}', '{\n "summary": "a"b"c"\n', 'explanation\n{\n "summary": "a"b"c"\n}',
    '{\n "summary": "a"b"c"\n}\n{}']) assert.equal(proposeQuotedLineSyntax(text), undefined, text)
  const existingEscapes = '{\n "summary": "已转义\\"正文\\"保留，再引"原文"。"\n}'
  assert.equal((proposeQuotedLineSyntax(existingEscapes)!.value as { summary: string }).summary, '已转义"正文"保留，再引"原文"。')
})

test('one compact explicit approval retains original response and validates the entire merged contract and evidence', async () => {
  const cp: StructuredOutputCheckpoint = {}; let calls = 0, validations = 0
  const result = await generateStructuredOutput('syntax_fixture', schema, async (prompt, contract) => {
    calls++
    if (calls === 1) return raw
    assert.equal(contract!.name, 'syntax_fixture_local_repair')
    assert.ok(!prompt.includes('LARGE_SOURCE_'.repeat(10)))
    return JSON.stringify(approval())
  }, 'LARGE_SOURCE_'.repeat(1000), { checkpoint: cp, planSyntaxRepair: quotedLineSyntaxRepair, validate(value) { validations++; assert.match(value.summary, /不是"替身"/) } })
  assert.equal(calls, 2); assert.equal(validations, 1); assert.deepEqual(result, proposeQuotedLineSyntax(raw)!.value)
  assert.equal(cp.original_raw, raw); assert.equal(cp.correction!.raw, JSON.stringify(approval())); assert.equal(cp.syntax_repair!.escape_offsets.length, 6)
})

test('false approval, forged binding, extra edits and complete-body rewrites never get adopted or retried', async () => {
  for (const patch of [{ ...approval(), approve: false }, { ...approval(), candidate_hash: '0'.repeat(64) }, { ...approval(), text: 'overwrite' }, proposeQuotedLineSyntax(raw)!.value]) {
    let calls = 0; const cp: StructuredOutputCheckpoint = {}
    await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => ++calls === 1 ? raw : JSON.stringify(patch), '', { checkpoint: cp, planSyntaxRepair: quotedLineSyntaxRepair }))
    assert.equal(calls, 2); assert.equal(cp.syntax_repair, undefined); assert.equal(cp.original_raw, raw)
  }
  let calls = 0
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => ++calls === 1 ? raw : JSON.stringify(approval()), '', {
    planSyntaxRepair: quotedLineSyntaxRepair, validate() { throw Object.assign(new Error('evidence invalid'), { statusCode: 422, validation_layer: 'evidence' }) },
  }), /evidence invalid/)
  assert.equal(calls, 2)
})

test('unknown correction and spent historical full correction never gain another request on upgrade', async () => {
  const cp: StructuredOutputCheckpoint = {}; let calls = 0
  const options = { checkpoint: cp, planSyntaxRepair: quotedLineSyntaxRepair, freezeCorrection: true }
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => { if (++calls === 1) return raw; throw new Error('unknown accepted') }, '', options), /unknown accepted/)
  const snapshot = structuredClone(cp)
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => assert.fail('unknown must not redispatch'), '', options))
  assert.deepEqual(cp, snapshot); assert.equal(calls, 2)
  const spent: StructuredOutputCheckpoint = {}; let oldCalls = 0
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => { oldCalls++; return raw }, '', { checkpoint: spent }))
  assert.equal(oldCalls, 2)
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => assert.fail('spent correction must not dispatch'), '', { checkpoint: spent, planSyntaxRepair: quotedLineSyntaxRepair }), /逐字相同/)
  assert.equal(spent.syntax_repair, undefined)
})

test('a crash after the compact response replays exact saved bytes without another model request', async () => {
  const cp: StructuredOutputCheckpoint = {}; let validations = 0
  const options = { checkpoint: cp, planSyntaxRepair: quotedLineSyntaxRepair, freezeCorrection: true,
    validate() { if (++validations === 1) throw Object.assign(new Error('source changed'), { statusCode: 409 }) } }
  let calls = 0
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => ++calls === 1 ? raw : JSON.stringify(approval()), '', options), /source changed/)
  const result = await generateStructuredOutput('syntax_fixture', schema, async () => assert.fail('replay never dispatches'), '', options)
  assert.deepEqual(result, proposeQuotedLineSyntax(raw)!.value); assert.equal(calls, 2)
})

test('map repairs only explicitly overlong locator summaries alongside syntax, preserving all facts and citations', async () => {
  const base = { sections: [{ start_unit: 0, title: '标题', episode_number: null, summary: '过长定位'.repeat(400), characters: [],
    events: [{ summary: '计划"保留"原文', evidence: { unit_id: 0 } }], open_threads: [] }] }
  const malformed = JSON.stringify(base, null, 2).replace('计划\\"保留\\"原文', '计划"保留"原文')
  const repair = sourceMapSyntaxRepair(malformed)!
  assert.ok(repair)
  const patched = repair.apply({ candidate_hash: createHash('sha256').update(malformed).digest('hex'), approve: true, repairs: { section_0_summary: '定位摘要。' } }) as typeof base
  assert.equal(patched.sections[0]!.summary, '定位摘要。'); assert.deepEqual(patched.sections[0]!.events, base.sections[0]!.events)
  assert.deepEqual(sourceMapSchema.parse(patched), { sections: [{ ...patched.sections[0]!, continues_previous: false }] })
  const wrongType = malformed.replace('"start_unit": 0', '"start_unit": "0"')
  assert.equal(sourceMapSyntaxRepair(wrongType), undefined)
})

test('deterministic unique recovery makes no approval call and still validates the whole contract', async () => {
  const { recoverUniqueQuotedLines } = await import('../src/modules/generation/model-output-syntax-repair.js')
  const cp: StructuredOutputCheckpoint = {}; let calls = 0
  const value = await generateStructuredOutput('syntax_fixture', schema, async () => { calls++; return raw }, 'source', {
    checkpoint: cp, recoverUniqueSyntax: true, validate(result) { assert.match(result.summary, /不是"替身"/) },
  })
  assert.equal(calls, 1); assert.equal(cp.original_raw, raw); assert.equal(cp.correction, undefined)
  assert.equal(cp.syntax_repair!.policy, 'quoted-lines-v2-deterministic')
  assert.deepEqual(value, recoverUniqueQuotedLines(raw)!.value)
  const duplicate = '{\n "summary": "a"b"c",\n "summary": "second"\n}'
  assert.equal(recoverUniqueQuotedLines(duplicate), undefined, 'JSON.parse must not silently discard the earlier duplicate')
  const ambiguous = '{\n "summary": "a"b",c"\n}'
  assert.equal(recoverUniqueQuotedLines(ambiguous), undefined, 'an inner quote with a JSON terminator is not automatically interpreted')
})

test('a historical explicit false syntax decision cannot be overridden by deterministic normalization', async () => {
  const cp: StructuredOutputCheckpoint = {}; let calls = 0
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => ++calls === 1 ? raw : JSON.stringify({ ...approval(), approve: false }), 'source', {
    checkpoint: cp, planSyntaxRepair: quotedLineSyntaxRepair,
  }))
  const before = structuredClone(cp)
  await assert.rejects(generateStructuredOutput('syntax_fixture', schema, async () => assert.fail('history must not redispatch'), 'source', {
    checkpoint: cp, recoverUniqueSyntax: true, planSyntaxRepair: quotedLineSyntaxRepair,
  }))
  assert.equal(cp.syntax_repair, undefined); assert.deepEqual(cp, before); assert.equal(calls, 2)
})

test('ambiguous fixed-line correction requires a reason and cannot rewrite, delete or mutate escaped text', async () => {
  const { reasonedQuotedLineRepair } = await import('../src/modules/generation/model-output-syntax-repair.js')
  const raw = '{\n  "summary": "提到"甲",而非乙。"\n}'
  const plan = reasonedQuotedLineRepair(raw)!, hash = createHash('sha256').update(raw).digest('hex')
  assert.ok(plan)
  const corrected = '  "summary": "提到\\"甲\\",而非乙。"'
  for (const patch of [
    { candidate_hash: hash, repairs: { line_0: { line: corrected } } },
    { candidate_hash: hash, repairs: { line_0: { line: '  "summary": "改写后"', reason: '不能改写' } } },
    { candidate_hash: hash, repairs: { line_0: { line: corrected, reason: '' } } },
    { candidate_hash: '0'.repeat(64), repairs: { line_0: { line: corrected, reason: '保持原文' } } },
  ]) assert.throws(() => plan.apply(patch))
  assert.deepEqual(plan.apply({ candidate_hash: hash, repairs: { line_0: { line: corrected, reason: '甲后的逗号是正文，不是字段分隔；仅补配对引号转义' } } }), { summary: '提到"甲",而非乙。' })
  assert.equal(plan.syntaxAudit!.policy, 'quoted-lines-v3-local')
})
