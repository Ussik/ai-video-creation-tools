import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { ensureStoryboardOutlineQuality } from '../src/modules/storyboard/storyboard-outline-quality.js'
import { storyboardValueSignature } from '../src/modules/storyboard/storyboard-review-scope.js'
import { StoryboardPlanningBudgetError } from '../src/modules/storyboard/storyboard-planning-budget.js'

// Synthetic fixture matching the reported shape; these are not the incident's unknown shot numbers.
const shotSchema = z.object({ shot_id: z.string(), title: z.string(), duration: z.number(), prompt: z.string(), start_state: z.string(), end_state: z.string(), cut_note: z.string() }).strict()
const schema = z.object({ scenes: z.array(z.object({ scene_id: z.string(), scene_duration: z.number(), scene_direction: z.object({ axis: z.string() }), shots: z.array(shotSchema) })) })
const outline = () => ({ scenes: [{ scene_id: 'synthetic-six', scene_duration: 35, scene_direction: { axis: '柜台北侧' },
  shots: Array.from({ length: 6 }, (_, index) => ({ shot_id: 'shot-' + index, title: '镜头' + index, duration: index === 5 ? 5 : 6,
    prompt: '动作' + index, start_state: '起点' + index, end_state: index === 5 ? '交接后手持钥匙' : index === 2 ? '交接后手持钥匙' : '终点' + index, cut_note: '接镜' + index })) }] })
const report = () => ({ issues: [
  { code: 'weak_cut', severity: 'warning', scene_id: 'synthetic-six', shot_index: 0, related_scene_id: null, related_shot_index: null,
    message: '本镜可停留', evidence: '接镜0', repair: '可选择保持' },
  { code: 'action_mismatch', severity: 'warning', scene_id: 'synthetic-six', shot_index: 2, related_scene_id: 'synthetic-six', related_shot_index: 1,
    message: '核对交接状态', evidence: '交接后手持钥匙', repair: '核对本镜终点',
    evidence_refs: [{ scene_id: 'synthetic-six', shot_index: 5, field: 'end_state', quote: '交接后手持钥匙' }] },
] })
function ledger(steps: Record<string, unknown> = {}) { return { steps, signal: new AbortController().signal,
  retain(key: string, value: unknown) { steps[key] = structuredClone(value) } } }
const key = (value: ReturnType<typeof outline>) => `six-shot:quality:v1:${storyboardValueSignature(value)}:report`
const patch = () => JSON.stringify({ repairs: { issue_1: { choice_id: 'choice_0' } } })

test('six-shot 35-second format-corrected review reaches bounded evidence correction without regenerating the outline', async () => {
  const original = outline(), rejected = report(), control = ledger(), calls: string[] = [], prompts: string[] = []
  const malformed = structuredClone(rejected)
  for (const issue of malformed.issues) { delete (issue as any).code; delete (issue as any).evidence; delete (issue as any).repair }
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control, context: {},
    generate: async (prompt, contract) => {
      calls.push(contract!.name); prompts.push(prompt)
      if (contract!.name === 'storyboard_outline_evidence_correction') return patch()
      return JSON.stringify(calls.length === 1 ? malformed : rejected)
    } })
  assert.deepEqual(await run(), original)
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_review', 'storyboard_outline_evidence_correction'])
  const saved = control.steps[key(original)] as ReturnType<typeof report>, expected = report()
  expected.issues[1]!.evidence_refs![0]!.shot_index = 2
  assert.equal(saved.issues.length, 2)
  assert.equal(saved.issues[1]!.evidence_refs![0]!.shot_index, 2)
  const { ref_id: _id, ...reference } = saved.issues[1]!.evidence_refs![0]! as any
  assert.deepEqual(reference, expected.issues[1]!.evidence_refs![0])
  for (const field of ['code', 'message', 'evidence', 'repair', 'repair_scope', 'scene_id', 'shot_index'])
    assert.deepEqual((saved.issues[1] as any)[field], (rejected.issues[1] as any)[field])
  assert.deepEqual((control.steps[key(original) + ':relation_rejected'] as any).report, rejected)
  const raw = control.steps[key(original) + ':structured_output:v1'] as any
  assert.equal(raw.original_raw || raw.raw, JSON.stringify(malformed))
  assert.equal(raw.correction.raw, JSON.stringify(rejected))
  await run()
  assert.equal(calls.length, 3, 'reopening/reusing the completed report does not dispatch')
})

test('an evidence quote with no safe local mapping stops and retains exact scope diagnostics instead of passing', async () => {
  const original = outline(), rejected = report(), control = ledger(), calls: string[] = []
  rejected.issues[1]!.evidence_refs![0]!.quote = original.scenes[0]!.shots[5]!.end_state = '仅远处镜头存在的事实'
  const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control, context: {}, generate: async (_prompt, contract) => {
    calls.push(contract!.name); return JSON.stringify(rejected)
  } })
  await assert.rejects(run(), (error: any) => {
    assert.equal(error.code, 'storyboard_outline_evidence_correction_failed')
    const diagnostic = JSON.parse(error.diagnostics)[0]
    assert.equal(diagnostic.issue_index, 1)
    assert.equal(diagnostic.rejected_refs[0].shot_index, 5)
    assert.ok(diagnostic.allowed_refs.some((reference: any) => reference.shot_index === 2 && reference.field === 'end_state'))
    return true
  })
  await assert.rejects(run(), { code: 'storyboard_outline_evidence_correction_exhausted' })
  assert.deepEqual(calls, ['storyboard_outline_review'], 'unsafe mapping cannot buy a replacement review')
  assert.deepEqual((control.steps[key(original) + ':relation_rejected'] as any).report, rejected)
})


test('restart before evidence correction reuses the rejected report without dispatching another review', async () => {
  const original = outline(), abort = new AbortController(), calls: string[] = []
  const first = { ...ledger(), signal: abort.signal, retain(key: string, value: unknown) {
    this.steps[key] = structuredClone(value)
    if (key.endsWith(':relation_rejected')) abort.abort(new Error('restart before correction'))
  } }
  const run = (control: ReturnType<typeof ledger>) => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema,
    validate() {}, control, context: {}, generate: async (_prompt, contract) => {
      calls.push(contract!.name)
      return contract!.name === 'storyboard_outline_evidence_correction' ? patch() : JSON.stringify(report())
    } })
  await assert.rejects(run(first), /restart before correction/)
  assert.deepEqual(calls, ['storyboard_outline_review'])
  assert.deepEqual(await run(ledger(structuredClone(first.steps))), original)
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_evidence_correction'])
})

test('budget and unknown correction outcome consume the durable allowance across controllers', async t => {
  for (const reason of ['budget', 'disconnect'] as const) await t.test(reason, async () => {
    const original = outline(), abort = new AbortController(), control = { ...ledger(), signal: abort.signal }, calls: string[] = []
    const budget = new StoryboardPlanningBudgetError('requests', true)
    const run = (control: ReturnType<typeof ledger>) => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema,
      validate() {}, control, context: {}, generate: async (_prompt, contract) => {
        calls.push(contract!.name)
        if (contract!.name === 'storyboard_outline_evidence_correction') {
          if (reason === 'budget') throw budget
          abort.abort(new Error('unknown correction outcome')); throw abort.signal.reason
        }
        return JSON.stringify(report())
      } })
    await assert.rejects(run(control), error => reason === 'budget' ? error === budget : /unknown correction outcome/.test(String(error)))
    await assert.rejects(run(ledger(structuredClone(control.steps))), { code: 'storyboard_outline_evidence_correction_exhausted' })
    assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_evidence_correction'])
    assert.deepEqual((control.steps[key(original) + ':relation_rejected'] as any).report, report())
  })
})

test('unresolved and illegal correction payloads stop once without changing the outline or findings', async t => {
  for (const repairs of [
    { issue_1: { choice_id: 'unresolved' } },
    { issue_1: { choice_id: 'invented_choice' } },
    { issue_1: { choice_id: 'choice_0', message: '改写问题', repair_scope: [] } },
  ]) await t.test(JSON.stringify(repairs), async () => {
    const original = outline(), before = JSON.stringify(original), control = ledger(), calls: string[] = []
    const run = () => ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control, context: {},
      generate: async (_prompt, contract) => {
        calls.push(contract!.name)
        return contract!.name === 'storyboard_outline_evidence_correction' ? JSON.stringify({ repairs }) : JSON.stringify(report())
      } })
    await assert.rejects(run(), { code: 'storyboard_outline_evidence_correction_failed' })
    await assert.rejects(run(), { code: 'storyboard_outline_evidence_correction_exhausted' })
    assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_evidence_correction'])
    assert.equal(JSON.stringify(original), before)
    assert.deepEqual((control.steps[key(original) + ':relation_rejected'] as any).report, report())
  })
})

test('ambiguous same-field text does not authorize a guessed mapping or another request', async () => {
  const original = outline(), control = ledger(), rejected = report(), calls: string[] = []
  original.scenes[0]!.shots[1]!.end_state = original.scenes[0]!.shots[5]!.end_state
  original.scenes[0]!.shots[3]!.end_state = original.scenes[0]!.shots[5]!.end_state
  await assert.rejects(ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control, context: {},
    generate: async (_prompt, contract) => { calls.push(contract!.name); return JSON.stringify(rejected) } }),
  { code: 'storyboard_outline_evidence_correction_failed' })
  assert.deepEqual(calls, ['storyboard_outline_review'])
})

test('evidence correction preserves error severity, exact prose and authorized repair fields', async () => {
  const { correctStoryboardOutlineEvidence } = await import('../src/modules/storyboard/storyboard-outline-evidence.js')
  const { storyboardDirectingReviewSchema, validateStoryboardDirectingReview } = await import('../src/modules/storyboard/storyboard-directing.js')
  const { normalizeStoryboardEvidenceReferences } = await import('../src/modules/storyboard/storyboard-review-scope.js')
  const original = outline(), rejected = storyboardDirectingReviewSchema.parse(report()), control = ledger()
  const issue = rejected.issues[1]!
  issue.severity = 'error'
  issue.repair_scope = [{ scene_id: 'synthetic-six', shot_index: 2, operation: 'replace', fields: ['end_state'] }]
  issue.evidence = '保留原报告解释'
  issue.evidence_refs![0]!.quote = '手持钥匙'
  const before = structuredClone(rejected)
  const accepted = await correctStoryboardOutlineEvidence({ report: rejected, key: 'error-review', scenes: original.scenes, control,
    generate: async () => patch(), validate(value) {
      validateStoryboardDirectingReview({ issues: value.issues.map(item => normalizeStoryboardEvidenceReferences(item, original.scenes, true)) }, original.scenes, { strictEvidence: true })
    } })
  assert.deepEqual(rejected, before)
  const expected = structuredClone(before)
  expected.issues[1]!.evidence_refs![0]!.shot_index = 2
  const { ref_id: _id, ...reference } = accepted.issues[1]!.evidence_refs![0]!
  assert.deepEqual(reference, expected.issues[1]!.evidence_refs![0])
  accepted.issues[1]!.evidence_refs = expected.issues[1]!.evidence_refs
  assert.deepEqual(accepted, expected)
})

test('bounded evidence correction omits unrelated source context and long skill rules', async () => {
  const original = outline(), control = ledger(), calls: string[] = []
  await ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control,
    context: { source_documents: 'UNRELATED_SOURCE'.repeat(10000), storyboard_rules: 'LONG_RULE'.repeat(10000) },
    generate: async (prompt, contract) => {
      calls.push(contract!.name)
      if (contract!.name !== 'storyboard_outline_evidence_correction') return JSON.stringify(report())
      assert.doesNotMatch(prompt, /UNRELATED_SOURCE|LONG_RULE|source_context/)
      assert.ok(prompt.length < 16000)
      return patch()
    } })
  assert.deepEqual(calls, ['storyboard_outline_review', 'storyboard_outline_evidence_correction'])
})


test('outline index preserves all unique facts while removing repeated primitive shot text', async () => {
  const { storyboardOutlineReviewContext } = await import('../src/modules/storyboard/storyboard-outline-review-context.js')
  const original = outline()
  const scene: any = original.scenes[0]!
  scene.scene_direction.blocking = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['actor' + i, '唯一调度' + i]))
  scene.shots[0].prompt = 'UNIQUE_LONG_ACTION_' + '甲'.repeat(1800)
  scene.shots[0].audio_plan = { speech: [{ text: '不可遗漏的正式台词' }] }
  scene.shots[0].extra_fact = '目录外的事实'
  const value = storyboardOutlineReviewContext(original.scenes)
  const indexed = value.outline_index.scenes[0]!.shots[0]!
  assert.equal(indexed.prompt, undefined)
  assert.equal(value.evidence_catalog.find(item => item.ref_id === indexed.field_refs.prompt)!.quote, scene.shots[0].prompt)
  assert.deepEqual(value.outline_index.scenes[0]!.scene_direction, scene.scene_direction)
  assert.deepEqual(indexed.audio_plan, scene.shots[0].audio_plan)
  assert.equal(indexed.extra_fact, '目录外的事实')
  assert.equal(JSON.stringify(value).split('UNIQUE_LONG_ACTION_').length - 1, 1)
})

test('format correction keeps current evidence but omits large unrelated source and rule context', async () => {
  const original = outline(), control = ledger(), prompts: string[] = [], malformed = report()
  delete (malformed.issues[0] as any).repair
  await ensureStoryboardOutlineQuality({ outline: original, outlineKey: 'six-shot', schema, validate() {}, control,
    context: { source_documents: 'LARGE_SOURCE_SENTINEL'.repeat(10000), storyboard_rules: 'RULE_SENTINEL'.repeat(10000) },
    generate: async (prompt, contract) => {
      prompts.push(prompt)
      if (contract!.name === 'storyboard_outline_evidence_correction') return patch()
      return JSON.stringify(prompts.length === 1 ? malformed : report())
    } })
  assert.match(prompts[0]!, /LARGE_SOURCE_SENTINEL|RULE_SENTINEL/)
  assert.doesNotMatch(prompts[1]!, /LARGE_SOURCE_SENTINEL|RULE_SENTINEL/)
  assert.match(prompts[1]!, /evidence_catalog/)
  assert.match(prompts[1]!, /交接后手持钥匙/)
  assert.ok(prompts[1]!.length < prompts[0]!.length / 5)
})
