import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoryboardDirectingReview } from '../src/modules/storyboard/storyboard-directing.js'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'

const directory = await mkdtemp(join(tmpdir(), 'storyboard-repair-scope-review-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { completeStoryboardRepairScope } = await import('../src/modules/storyboard/storyboard-repair-scope-review.js')
const { db } = await import('../src/infrastructure/database/db.js')
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

type Field = { key: string; scene_id: string; shot_index: number | null; field: string; current: unknown }
type AuditInput = { fields: Field[]; issues: StoryboardDirectingReview['issues'] }
type AuditResult = { outcome: 'complete' | 'inconclusive'; checked_fields: string[];
  additions: Array<{ issue_index: number; field_key: string; quote: string; reason: string }> }
const cut = (state: string) => ({ type: 'action_match', cut_moment: '在拇指接近封口时切出', carry_over: state, reason: '切近看清下一步按压' })
const shot = (position: number) => ({ shot_id: `shot-${position}`, title: '检查信封', prompt: '快递员检查信封封口',
  image_prompt: '双手托住信封，拇指指腹已接触封口边缘',
  video_prompt: position === 0 ? '拇指移向封口边缘，保持约2-3厘米距离' : '拇指已接触封口，随后缓慢按压',
  start_state: position === 0 ? '双手托住信封' : '拇指指腹已接触封口边缘，准备施力按压',
  end_state: position === 0 ? '拇指距离封口边缘约2-3厘米，尚未触碰' : '封口压平，信封放回原格',
  cut_note: '保留检查与再次确认的完整动作', duration: 6,
  audio_plan: { speech: [], sound_effects: ['纸面摩擦'], music: '', silent: false },
  directing: { purpose: '交代检查动作', camera: { movement: '固定', start_frame: '双手和信封的近景', trigger: '保持',
    path: '保持固定', end_frame: '双手与信封保持在画面内', motivation: '看清手部动作' }, cut: cut('拇指距离封口约2-3厘米') } })
const candidate = () => ({ scenes: [{ scene_id: 'scene', scene_direction: { anchors: '同一个敞开格口', blocking: '快递员站在格口前',
  axis: '保持同侧', dramatic_progression: '检查后压平再放回' }, shots: [shot(0), shot(1)] },
  { scene_id: 'unrelated', scene_direction: { anchors: '另一场的门口' }, shots: [shot(2)] }] })
const issue = (): StoryboardDirectingReview['issues'][number] => ({ code: 'action_mismatch', scene_id: 'scene', shot_index: 1,
  related_scene_id: 'scene', related_shot_index: 0, timing_change: false, severity: 'error',
  message: '前镜尚未触碰，后镜已触碰，动作交接不一致', evidence: '前镜拇指距离封口边缘约2-3厘米，尚未触碰；后镜拇指指腹已接触封口边缘',
  repair: '前镜收镜改为拇指轻触封口边缘，保留后镜按压动作',
  evidence_refs: [{ scene_id: 'scene', shot_index: 0, field: 'end_state', quote: '拇指距离封口边缘约2-3厘米，尚未触碰' },
    { scene_id: 'scene', shot_index: 0, field: 'directing.cut', quote: '拇指距离封口约2-3厘米' }],
  repair_scope: [{ scene_id: 'scene', shot_index: 0, operation: 'replace', fields: ['end_state', 'directing.cut'] }] })
const report = (): StoryboardDirectingReview => ({ issues: [issue()] })
const ledger = () => { const steps: Record<string, unknown> = {}; return { steps, retain(key: string, value: unknown) { steps[key] = structuredClone(value) } } }
const input = (prompt: string): AuditInput => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as AuditInput
const field = (data: AuditInput, scene: string, index: number | null, name: string) => {
  const value = data.fields.find(item => item.scene_id === scene && item.shot_index === index && item.field === name)
  assert.ok(value, `Missing current field ${scene}/${index}/${name}`); return value
}
const complete = (data: AuditInput): AuditResult => ({ outcome: 'complete', checked_fields: data.fields.map(item => item.key), additions: [] })
const addVideo = (data: AuditInput): AuditResult => ({ ...complete(data), additions: [{ issue_index: 0,
  field_key: field(data, 'scene', 0, 'video_prompt').key, quote: '保持约2-3厘米距离', reason: '同一收镜动作还在视频正文要求保持距离，必须一起改为轻触状态' }] })

test('scope audit adds the omitted video constraint to the original defect without rewriting its identity or the correct neighbour', async () => {
  const original = candidate(), defects = report(), originalBytes = JSON.stringify(original), reportBytes = JSON.stringify(defects)
  let calls = 0
  const result = await completeStoryboardRepairScope({ candidate: original, report: defects, prompt: '以当前正式来源为准',
    generate: async (prompt, contract) => {
      calls++; assert.equal(contract!.name, 'storyboard_repair_scope_review')
      const data = input(prompt)
      assert.deepEqual(data.issues, defects.issues)
      assert.ok(data.fields.length > 2)
      assert.ok(data.fields.every(item => item.scene_id === 'scene' && item.shot_index !== null && !['duration', 'audio_plan'].includes(item.field)))
      assert.equal(new Set(data.fields.map(item => item.key)).size, data.fields.length)
      assert.equal(field(data, 'scene', 0, 'video_prompt').current, original.scenes[0]!.shots[0]!.video_prompt)
      return JSON.stringify(addVideo(data))
    } })
  const expected = report()
  expected.issues[0]!.repair_scope![0]!.fields.push('video_prompt')
  expected.issues[0]!.evidence_refs!.push({ scene_id: 'scene', shot_index: 0, field: 'video_prompt', quote: '保持约2-3厘米距离' })
  assert.deepEqual(result.report, expected)
  assert.deepEqual(result.notes, [{ issue_index: 0, scene_id: 'scene', shot_index: 0, field: 'video_prompt', reason: '同一收镜动作还在视频正文要求保持距离，必须一起改为轻触状态' }])
  assert.equal(calls, 1); assert.equal(JSON.stringify(original), originalBytes); assert.equal(JSON.stringify(defects), reportBytes)
  assert.ok(!result.report.issues[0]!.repair_scope!.some(scope => scope.shot_index === 1))
})

test('complete scope audit with no additions preserves the original error and never turns it into passed quality', async () => {
  const defects = report()
  const result = await completeStoryboardRepairScope({ candidate: candidate(), report: defects, prompt: '', generate: async prompt => JSON.stringify(complete(input(prompt))) })
  assert.deepEqual(result, { report: defects, notes: [] }); assert.equal(result.report.issues[0]!.severity, 'error')
})

test('unsafe or incomplete audit output cannot authorize a downstream repair', async t => {
  for (const variant of ['false_quote', 'unknown_key', 'invalid_issue', 'already_scoped', 'duplicate_addition',
    'missing_checked_field', 'duplicate_checked_field', 'inconclusive', 'oversized_reason', 'oversized_quote'] as const) await t.test(variant, async () => {
    let first: AuditInput | undefined, repairReached = false
    const generate: StructuredGenerator = async prompt => {
      first ??= input(prompt)
      const data = first, output = addVideo(data), addition = output.additions[0]!
      if (variant === 'false_quote') addition.quote = '原文没有的手指已经完成按压'
      if (variant === 'unknown_key') addition.field_key = 'caller_owned_unknown_path'
      if (variant === 'invalid_issue') addition.issue_index = 9
      if (variant === 'already_scoped') { addition.field_key = field(data, 'scene', 0, 'end_state').key; addition.quote = '尚未触碰' }
      if (variant === 'duplicate_addition') output.additions.push({ ...addition })
      if (variant === 'missing_checked_field') output.checked_fields.pop()
      if (variant === 'duplicate_checked_field') output.checked_fields.push(output.checked_fields[0]!)
      if (variant === 'inconclusive') output.outcome = 'inconclusive'
      if (variant === 'oversized_reason') addition.reason = '未核实'.repeat(150)
      if (variant === 'oversized_quote') addition.quote = '不存在'.repeat(700)
      return JSON.stringify(output)
    }
    await assert.rejects(async () => { await completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '', generate }); repairReached = true })
    assert.equal(repairReached, false)
  })
})

test('a field visible for another defect cannot be attached to an unrelated issue or warning', async t => {
  for (const warning of [false, true]) await t.test(warning ? 'warning' : 'other_defect', async () => {
    const plan = candidate(), defects = report(), second = issue()
    second.scene_id = 'unrelated'; second.shot_index = 0; second.related_scene_id = null; second.related_shot_index = null
    second.evidence_refs = [{ scene_id: 'unrelated', shot_index: 0, field: 'start_state', quote: '拇指指腹已接触封口边缘' }]
    second.repair_scope = [{ scene_id: 'unrelated', shot_index: 0, operation: 'replace', fields: ['start_state'] }]
    defects.issues.push(second)
    if (warning) defects.issues[0]!.severity = 'warning'
    let data: AuditInput | undefined
    await assert.rejects(completeStoryboardRepairScope({ candidate: plan, report: defects, prompt: '', generate: async prompt => {
      data ??= input(prompt)
      return JSON.stringify({ ...complete(data), additions: [{ issue_index: 0,
        field_key: field(data, 'unrelated', 0, 'video_prompt').key, quote: '拇指已接触封口', reason: '错误地把另一缺陷或warning的字段算作当前问题修复' }] })
    } }))
  })
})

test('scene fields are eligible only when that exact issue already authorizes scene repair', async () => {
  const defects = report()
  defects.issues[0]!.repair_scope!.push({ scene_id: 'scene', shot_index: null, operation: 'replace', fields: ['scene_direction.blocking'] })
  defects.issues[0]!.evidence_refs!.push({ scene_id: 'scene', shot_index: null, field: 'scene_direction.blocking', quote: '快递员站在格口前' })
  const result = await completeStoryboardRepairScope({ candidate: candidate(), report: defects, prompt: '', generate: async prompt => {
    const data = input(prompt)
    const item = field(data, 'scene', null, 'scene_direction.dramatic_progression')
    return JSON.stringify({ ...complete(data), additions: [{ issue_index: 0, field_key: item.key, quote: '检查后压平再放回', reason: '同一场面调度的动作顺序需要同步修正' }] })
  } })
  assert.ok(result.report.issues[0]!.repair_scope!.some(scope => scope.shot_index === null && scope.fields.includes('scene_direction.dramatic_progression')))
})

test('audit checkpoint resumes without dispatch, while changed candidate or creator context requires fresh evidence', async () => {
  const control = ledger(); let calls = 0
  const generate: StructuredGenerator = async prompt => { calls++; return JSON.stringify(addVideo(input(prompt))) }
  const first = await completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '原始创作者要求', generate, control })
  assert.equal(calls, 1)
  assert.deepEqual(await completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '原始创作者要求', generate, control }), first)
  assert.equal(calls, 1)
  const changed = candidate(); changed.scenes[0]!.shots[0]!.video_prompt += '，只生成本镜动作'
  await completeStoryboardRepairScope({ candidate: changed, report: report(), prompt: '原始创作者要求', generate, control }); assert.equal(calls, 2)
  await completeStoryboardRepairScope({ candidate: changed, report: report(), prompt: '更新后的创作者要求', generate, control }); assert.equal(calls, 3)
})

test('corrupt saved audit evidence stops without deleting its checkpoint or paying for another review', async () => {
  const control = ledger(); let calls = 0
  const generate: StructuredGenerator = async prompt => { calls++; return JSON.stringify(addVideo(input(prompt))) }
  await completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '', generate, control })
  const keys = Object.keys(control.steps); assert.ok(keys.length)
  for (const key of keys) control.steps[key] = { malformed: 'retained corrupt audit receipt' }
  const corrupted = structuredClone(control.steps)
  await assert.rejects(completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '', generate, control }))
  assert.equal(calls, 1); assert.deepEqual(control.steps, corrupted)
})

test('cancellation before or during the audit cannot retain new authorization or reach repair', async t => {
  for (const before of [true, false]) await t.test(before ? 'before_dispatch' : 'during_dispatch', async () => {
    const controller = new AbortController(), control = ledger(); let calls = 0, repairReached = false
    if (before) controller.abort(new DOMException('用户停止', 'AbortError'))
    await assert.rejects(async () => {
      await completeStoryboardRepairScope({ candidate: candidate(), report: report(), prompt: '', control, signal: controller.signal,
        generate: async prompt => { calls++; controller.abort(new DOMException('用户停止', 'AbortError')); return JSON.stringify(addVideo(input(prompt))) } })
      repairReached = true
    })
    assert.equal(calls, before ? 0 : 1); assert.deepEqual(control.steps, {}); assert.equal(repairReached, false)
  })
})


test('source-backed untyped warnings survive scope completion and source changes invalidate cached audit evidence', async () => {
  const control = ledger(), defects = report(), warning = issue()
  warning.severity = 'warning'
  warning.message = '来源中的停顿属于创作者节奏选择，保留该建议供确认'
  warning.evidence = '快递员检查后略作停顿再放回信封'
  warning.repair = '保留动作顺序，由创作者判断停顿是否需要强调'
  delete warning.evidence_refs; delete warning.repair_scope
  defects.issues.push(warning)
  const original = structuredClone(defects), source = '快递员检查后略作停顿再放回信封。', changedSource = source + '柜门始终敞开。'
  let calls = 0
  const generate: StructuredGenerator = async prompt => {
    calls++
    const data = input(prompt)
    assert.deepEqual(data.issues[1], warning)
    return JSON.stringify(addVideo(data))
  }
  const run = (sourceTexts: string[]) => completeStoryboardRepairScope({ candidate: candidate(), report: defects,
    sourceTexts, prompt: '按当前来源核对动作约束', generate, control })
  const first = await run([source])
  assert.equal(calls, 1); assert.deepEqual(first.report.issues[1], warning); assert.deepEqual(defects, original)
  assert.equal(first.report.issues[0]!.severity, 'error')
  assert.deepEqual(await run([source]), first); assert.equal(calls, 1)
  const changed = await run([changedSource])
  assert.equal(calls, 2); assert.deepEqual(changed.report.issues[1], warning)
  assert.deepEqual(await run([changedSource]), changed); assert.equal(calls, 2)
})
