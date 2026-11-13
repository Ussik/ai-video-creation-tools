import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StructuredGenerator } from '../src/modules/generation/model-output.js'
import { promptRefinementSemanticIssues, reviewPromptRefinement,
  type PromptRefinementSemanticInput, type PromptRefinementSemanticReview } from '../src/modules/skills/prompt-refinement-semantics.js'

type SourceKey = 'source' | 'adjustment' | 'candidate'
type LocatorData = {
  issues: Array<{ id: string; source_key: SourceKey; review_item: unknown }>
  sources: Array<{ key: SourceKey; units: Array<{ id: number; text: string }> }>
}
type Repair = { id: string; first_unit: number | null; last_unit: number | null }
type Locator = (data: LocatorData, attempt: number) => unknown

function input(overrides: Partial<PromptRefinementSemanticInput> = {}): PromptRefinementSemanticInput {
  return { source: '陆照霜从车厢远端跑来。列车颠簸，她失去平衡。',
    candidate: '陆照霜从远端跑近，颠簸让她失衡，左手撑地后抬起上身。',
    adjustment: '先完整呈现从远到近的奔跑，再呈现摔倒与缓冲。', board: false,
    stage: 'video_prompt', identities: [], readonly_context: null, ...overrides }
}
function review(): PromptRefinementSemanticReview {
  return { content_review: null, dialogue: [], request_conflicts: [],
    checks: (['facts', 'reference_identity', 'character_presence', 'board_views', 'requested_changes'] as const).map(category => ({
      category, status: 'not_applicable', description: '此类无额外变化。',
      source_evidence: '', adjustment_evidence: '', candidate_evidence: '',
    })) }
}
function locatorData(prompt: string): LocatorData {
  const marker = '【待定位证据（资料）】\n', offset = prompt.lastIndexOf(marker)
  assert.ok(offset >= 0, '证据定位必须提供标记清晰的资料')
  return JSON.parse(prompt.slice(offset + marker.length)) as LocatorData
}
function range(data: LocatorData, key: SourceKey, quote: string): Pick<Repair, 'first_unit' | 'last_unit'> {
  const source = data.sources.find(item => item.key === key)
  assert.ok(source, `定位资料缺少 ${key}`)
  const text = source.units.map(unit => unit.text).join(''), start = text.indexOf(quote)
  assert.ok(start >= 0, `定位资料缺少待选原文：${quote}`)
  let offset = 0
  const selected = source.units.filter(unit => {
    const first = offset
    offset += unit.text.length
    return offset > start && first < start + quote.length
  })
  assert.ok(selected.length)
  return { first_unit: selected[0]!.id, last_unit: selected.at(-1)!.id }
}
function repairs(data: LocatorData, targets: Record<string, string>) {
  return { repairs: data.issues.map(issue => ({ id: issue.id,
    ...range(data, issue.source_key, targets[issue.id] ?? assert.fail(`未预期的证据路径 ${issue.id}`)),
  })) }
}
function generator(report: PromptRefinementSemanticReview, locate: Locator = () => assert.fail('合法证据不应触发定位')) {
  const calls: string[] = [], data: LocatorData[] = []
  let attempts = 0
  const generate: StructuredGenerator = async (prompt, contract) => {
    assert.ok(contract)
    calls.push(contract.name)
    if (contract.name === 'prompt_refinement_semantic_review') return JSON.stringify(report)
    assert.equal(contract.name, 'prompt_refinement_evidence_repair')
    const parsed = locatorData(prompt)
    data.push(parsed)
    return JSON.stringify(locate(parsed, ++attempts))
  }
  return { generate, calls, data }
}
const count = (calls: string[], name: string) => calls.filter(call => call === name).length

test('already exact semantic evidence returns the original report without another model request', async () => {
  const source = input(), report = review()
  Object.assign(report.checks[0]!, { status: 'preserved', description: '失衡的剧情因果已保留。',
    source_evidence: '列车颠簸，她失去平衡。', candidate_evidence: '颠簸让她失衡' })
  const mock = generator(report)
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.deepEqual(result, report)
  assert.deepEqual(mock.calls, ['prompt_refinement_semantic_review'])
})

test('paraphrased evidence is located without erasing an existing semantic failure', async () => {
  const source = input(), report = review(), description = '候选尚未体现失败的促补步，动作因果仍不完整。'
  Object.assign(report.checks[0]!, { status: 'missing', description, source_evidence: '她因火车晃动而失衡。' })
  const original = structuredClone(report)
  const mock = generator(report, data => repairs(data, { 'checks[0].source_evidence': '列车颠簸，她失去平衡。' }))
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.checks[0]!.source_evidence, '列车颠簸，她失去平衡。')
  assert.deepEqual({ ...result, checks: result.checks.map((check, index) => index ? check : {
    ...check, source_evidence: original.checks[0]!.source_evidence,
  }) }, original)
  assert.deepEqual(promptRefinementSemanticIssues(result, source.candidate), [description])
  assert.deepEqual(mock.calls, ['prompt_refinement_semantic_review', 'prompt_refinement_evidence_repair'])
})

test('stitched evidence selects a continuous passage including the intervening sentences', async () => {
  const source = input({ source: '她从远端跑来。车厢灯光闪烁。列车颠簸，她失去平衡。' }), report = review()
  report.checks[0]!.source_evidence = '她从远端跑来。列车颠簸，她失去平衡。'
  const mock = generator(report, data => repairs(data, { 'checks[0].source_evidence': source.source }))
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.checks[0]!.source_evidence, source.source)
  assert.match(result.checks[0]!.source_evidence, /车厢灯光闪烁/)
})

test('locations preserve newlines, punctuation and non-BMP characters across bounded units', async () => {
  const prose = `${'车'.repeat(199)}🚆仍在行进\n她伸出左手。\n膝盖触地，手臂弯曲承重。`, source = input({ source: prose }), report = review()
  report.checks[0]!.source_evidence = '她伸手撑地并屈臂承重。'
  const mock = generator(report, data => {
    const units = data.sources.find(item => item.key === 'source')!.units
    assert.equal(units.map(unit => unit.text).join(''), prose)
    assert.ok(units.length > 2)
    for (const unit of units) {
      for (let index = 0; index < unit.text.length; index++) {
        const code = unit.text.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) assert.ok(unit.text.charCodeAt(index + 1) >= 0xdc00 && unit.text.charCodeAt(index + 1) <= 0xdfff)
        if (code >= 0xdc00 && code <= 0xdfff) assert.ok(index > 0 && unit.text.charCodeAt(index - 1) >= 0xd800 && unit.text.charCodeAt(index - 1) <= 0xdbff)
      }
    }
    return repairs(data, { 'checks[0].source_evidence': prose })
  })
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.checks[0]!.source_evidence, prose)
})

test('each check, dialogue authorization and conflict evidence resolves only against its own input', async () => {
  const source = input({ source: '陆照霜说：“别过来。”', candidate: '陆照霜说：“快走。”',
    adjustment: '把“别过来。”改成“快走。”，其余保持。' }), report = review()
  Object.assign(report.checks[0]!, { status: 'authorized_change', source_evidence: '她说别过来。',
    adjustment_evidence: '本次授权改为快走。', candidate_evidence: '她改说快走。' })
  report.dialogue.push({ speaker: '陆照霜', text: '别过来。', source_evidence: '她说：“别过来。”',
    authorized_change: true, authorization_evidence: '允许改台词。' })
  report.request_conflicts.push({ message: '该调整与既定展示要求冲突。', evidence: '改变指定台词。' })
  const targets = { 'checks[0].source_evidence': source.source, 'checks[0].adjustment_evidence': source.adjustment,
    'checks[0].candidate_evidence': source.candidate, 'dialogue[0].source_evidence': source.source,
    'dialogue[0].authorization_evidence': source.adjustment, 'request_conflicts[0].evidence': source.adjustment }
  const mock = generator(report, data => {
    const ids = data.sources.flatMap(item => item.units.map(unit => unit.id))
    assert.equal(new Set(ids).size, ids.length, '不同输入的单元编号不能碰撞')
    assert.equal(data.issues.find(item => item.id === 'checks[0].candidate_evidence')!.source_key, 'candidate')
    assert.equal(data.issues.find(item => item.id === 'dialogue[0].authorization_evidence')!.source_key, 'adjustment')
    assert.equal(data.issues.find(item => item.id === 'dialogue[0].source_evidence')!.source_key, 'source')
    return repairs(data, targets)
  })
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.dialogue[0]!.text, '别过来。')
  assert.equal(result.dialogue[0]!.authorized_change, true)
  assert.equal(result.dialogue[0]!.source_evidence, source.source)
  assert.equal(result.dialogue[0]!.authorization_evidence, source.adjustment)
  assert.equal(result.checks[0]!.candidate_evidence, source.candidate)
  assert.equal(result.request_conflicts[0]!.message, report.request_conflicts[0]!.message)
  assert.equal(result.request_conflicts[0]!.evidence, source.adjustment)
})

test('a locator cannot borrow candidate units to repair source evidence', async () => {
  const source = input(), report = review()
  report.checks[0]!.source_evidence = '拼写不精确的基稿证据。'
  report.checks[0]!.candidate_evidence = '拼写不精确的候选证据。'
  const mock = generator(report, data => ({ repairs: data.issues.map(issue => ({ id: issue.id,
    ...range(data, 'candidate', source.candidate),
  })) }))
  await assert.rejects(reviewPromptRefinement(source, mock.generate))
  assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
})

test('nonexistent evidence coordinates exhaust only one locator correction', async () => {
  const report = review()
  report.checks[0]!.source_evidence = '概述式引文。'
  const mock = generator(report, data => {
    const invalid = Math.max(...data.sources.flatMap(item => item.units.map(unit => unit.id))) + 1
    return { repairs: data.issues.map(issue => ({ id: issue.id, first_unit: invalid, last_unit: invalid })) }
  })
  await assert.rejects(reviewPromptRefinement(input(), mock.generate))
  assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
})

test('a locator cannot duplicate or omit pending evidence paths', async t => {
  for (const mode of ['duplicate', 'omitted'] as const) await t.test(mode, async () => {
    const report = review()
    report.checks[0]!.source_evidence = '第一条错误引文。'
    report.checks[1]!.source_evidence = '第二条错误引文。'
    const mock = generator(report, data => {
      const valid = repairs(data, { 'checks[0].source_evidence': '陆照霜从车厢远端跑来。',
        'checks[1].source_evidence': '列车颠簸，她失去平衡。' }).repairs
      return { repairs: mode === 'duplicate' ? [valid[0], valid[0]] : valid.slice(0, 1) }
    })
    await assert.rejects(reviewPromptRefinement(input(), mock.generate))
    assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
  })
})

test('unlocatable evidence cannot be cleared to produce a passed review', async () => {
  const report = review()
  Object.assign(report.checks[0]!, { status: 'missing', description: '基稿存在一项未落实要求。', source_evidence: '缺乏原文支持的引文。' })
  const mock = generator(report, data => ({ repairs: data.issues.map(issue => ({ id: issue.id, first_unit: null, last_unit: null })) }))
  await assert.rejects(reviewPromptRefinement(input(), mock.generate))
  assert.ok(count(mock.calls, 'prompt_refinement_evidence_repair') <= 2)
  assert.equal(report.checks[0]!.status, 'missing')
  assert.equal(report.checks[0]!.source_evidence, '缺乏原文支持的引文。')
})

test('invented spoken words cannot become genuine by locating an unrelated source passage', async () => {
  const source = input({ source: '陆照霜没有开口，低头撑住地面。' }), report = review()
  report.dialogue.push({ speaker: '陆照霜', text: '快来救我。', source_evidence: '陆照霜喊：“快来救我。”',
    authorized_change: false, authorization_evidence: '' })
  const mock = generator(report, data => repairs(data, { 'dialogue[0].source_evidence': source.source }))
  await assert.rejects(reviewPromptRefinement(source, mock.generate))
  assert.equal(report.dialogue[0]!.text, '快来救我。')
})

test('a dialogue at the evidence length limit keeps its complete verified words without the surrounding speaker cue', async () => {
  const text = '你'.repeat(3999) + '。', source = input({ source: `甲：${text}`, candidate: text }), report = review()
  report.dialogue.push({ speaker: '甲', text, source_evidence: '甲说了一段很长的原话。',
    authorized_change: false, authorization_evidence: '' })
  const mock = generator(report, data => repairs(data, { 'dialogue[0].source_evidence': source.source }))
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.dialogue[0]!.text, text)
  assert.equal(result.dialogue[0]!.source_evidence, text)
  assert.equal(result.dialogue[0]!.source_evidence.length, 4000)
  assert.ok(source.source.includes(result.dialogue[0]!.source_evidence))
  assert.deepEqual(promptRefinementSemanticIssues(result, source.candidate), [])
  assert.deepEqual(mock.calls, ['prompt_refinement_semantic_review', 'prompt_refinement_evidence_repair'])
})

test('a real dialogue cannot use a selected passage that omits its complete words', async () => {
  const text = '别过来。', unrelated = '陆照霜扶住车厢墙壁。', source = input({ source: `甲：“${text}”\n${unrelated}` }), report = review()
  report.dialogue.push({ speaker: '甲', text, source_evidence: '甲开口阻止对方靠近。',
    authorized_change: false, authorization_evidence: '' })
  const mock = generator(report, data => repairs(data, { 'dialogue[0].source_evidence': unrelated }))
  await assert.rejects(reviewPromptRefinement(source, mock.generate))
  assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
  assert.equal(report.dialogue[0]!.text, text)
})

test('evidence repair cannot smuggle rewritten conclusions into a valid coordinate response', async () => {
  const report = review()
  Object.assign(report.checks[0]!, { status: 'changed', description: '候选更改了基稿因果。', source_evidence: '概述式引文。' })
  const mock = generator(report, data => ({ ...repairs(data, { 'checks[0].source_evidence': '列车颠簸，她失去平衡。' }),
    checks: [{ category: 'facts', status: 'preserved', description: '已通过。' }],
  }))
  await assert.rejects(reviewPromptRefinement(input(), mock.generate))
  assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
  assert.equal(report.checks[0]!.status, 'changed')
})

test('one corrected locator response repairs evidence while retaining all semantic findings', async () => {
  const source = input(), report = review()
  Object.assign(report.checks[0]!, { status: 'uncertain', description: '还不能确认动作是否完整。', source_evidence: '概述式引文。' })
  const mock = generator(report, (data, attempt) => attempt === 1
    ? { repairs: data.issues.map(issue => ({ id: issue.id, first_unit: -1, last_unit: -1 })) }
    : repairs(data, { 'checks[0].source_evidence': '列车颠簸，她失去平衡。' }))
  const result = await reviewPromptRefinement(source, mock.generate)
  assert.equal(result.checks[0]!.source_evidence, '列车颠簸，她失去平衡。')
  assert.equal(result.checks[0]!.status, 'uncertain')
  assert.equal(result.checks[0]!.description, '还不能确认动作是否完整。')
  assert.equal(count(mock.calls, 'prompt_refinement_evidence_repair'), 2)
  assert.equal(count(mock.calls, 'prompt_refinement_semantic_review'), 1)
})
