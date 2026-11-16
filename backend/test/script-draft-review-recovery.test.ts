import { reviewCoordinateDraftFixture as reviewScriptDraftCompleteness, draftReviewFixtureSources, draftReviewCoordinateMaterial } from './fixtures/script-draft-coordinate-response.js'
import { draftReviewFixtureJson } from './fixtures/script-draft-completeness.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { TextOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { beginTextRequest } from '../src/infrastructure/providers/text-request-usage.js'
import { ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import { ReviewPaginationStalledError } from '../src/modules/script/script-review-pagination.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'

const directory = await mkdtemp(join(tmpdir(), 'draft-review-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'review recovery fixtures must never open the workspace database')
const { generationCheckpointStore } = await import('../src/modules/script/script-generation-checkpoints.js')
const { sourceProposalBudget, scriptProposalBudgetScope } = await import('../src/modules/script/script-proposal-budget.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const dimensions = ['settings', 'consistency', 'requirements'] as const
const expected = [...scriptStageArtifacts.outline]
const clear = () => ({ facts: [], checked_artifacts: expected, findings: [] })
const resultText = (value: unknown = clear()) => draftReviewFixtureJson(value)
const emptyResult = (contract?: OutputContract) => resultText(contract?.name.endsWith('_page') ? { items: [], complete: true } : clear())
const exhausted = (partialText = '') => new TextOutputLimitError(partialText, 'length', {
  input_tokens: 66_000, output_tokens: 65_535, reasoning_tokens: 65_535,
})
function dimension(prompt: string): string {
  return /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
}
function submitted(prompt: string) { return draftReviewFixtureSources(prompt) }
function reviewContext(prompt: string) {
  const start = '既有事实与创作要求（资料）：'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(start) + start.length).split('\n【审读结果分页协议】')[0]!)
}
function fixture() {
  const projectId = newId(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '长阶段草稿核对恢复', timestamp, timestamp)
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0,
    artifacts: expected.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `第${index}份完整文档开头。\n` + `第${index}份独有剧情与因果。`.repeat(300) + `\n第${index}份完整文档结尾。` })), scenes: [] }
  const context = {
    project: { name: '完整作品', brief: '保留全部主线、人数和结局' },
    uploaded_script: { project_id: projectId, filename: '原稿.md', content: '开场：十七个位置已满。\n' + '所有原文必须保留。'.repeat(300) + '\n结局：主角撤掉神位。',
      updated_at: timestamp, revision: 2, analysis: { source_version: 'effective-story-v2', status: 'ready', work: ['不应再次发送的分析运行态'],
        story: { summary: '伴随完整原文的全剧理解：十七位容量已满，主角最终撤掉神位。' } } },
    saved_documents: [{ id: 'saved', title: '已保存设定', content: '完整既有设定。'.repeat(100) }],
    creator_messages: [{ role: 'assistant', text: '方案二保留资源已用尽的原文条件。' }, { role: 'user', text: '沿用方案二，结局不变。',
      reference_documents: [{ id: 'reference', title: '补充约束', content: '完整引用：十七位容量不得扩展。'.repeat(30) }] }],
    confirmed_decisions: [{ id: 'confirmed', topic: '名单容量', content: '十七个位置已满' }],
    resolved_findings: { decisions: [{ id: 'resolved', answer: '签已用尽', decision: '不得增加第十八个位置' }], summaries: [] },
    current_settings: { episode_count: 60 }, requested_settings: { episode_count: 60 }, task_scope: { stage: 'outline' },
  }
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', projectId,
    context.uploaded_script.filename, context.uploaded_script.content, timestamp)
  const identity = { projectId, candidate: 'same-exact-candidate' }
  const store = () => generationCheckpointStore(projectId, identity, 'review-recovery-test')
  const steps = (signal?: AbortSignal) => {
    const checkpoint = store()
    return createGenerationSteps({ checkpoint: checkpoint.checkpoint, save: checkpoint.save,
      savePrivateResponse: checkpoint.savePrivateResponse, signal })
  }
  const assertComplete = (prompt: string) => {
    assert.deepEqual(submitted(prompt).map(({ artifact_type, content }) => ({ artifact_type, content })),
      draft.artifacts.map(({ artifact_type, content }) => ({ artifact_type, content })), 'every dimension receives all nine complete candidate documents')
    const sent = reviewContext(prompt)
    assert.equal(sent.uploaded_script.content, context.uploaded_script.content)
    assert.deepEqual(sent.uploaded_script.analysis, { source_version: context.uploaded_script.analysis.source_version,
      story: context.uploaded_script.analysis.story }, 'final whole-story understanding and its version accompany the full manuscript')
    for (const key of ['saved_documents', 'creator_messages', 'confirmed_decisions', 'resolved_findings', 'task_scope'] as const) {
      assert.deepEqual(sent[key], context[key], `${key} remains complete in every dimension`)
    }
  }
  return { projectId, draft, context, store, steps, assertComplete }
}
function finding(draft: WorkflowDraft, index: number, description = `第${index}项实质创作问题`) {
  const artifact = draft.artifacts[index % draft.artifacts.length]!
  return { source_key: artifact.artifact_type, kind: 'contradiction' as const,
    quote: `第${index % draft.artifacts.length}份完整文档开头。`, explanation: description, suggestion: `落实第${index}项原稿约束。` }
}
const has = (checkpoint: GenerationCheckpoint, id: string) => Object.hasOwn(checkpoint.steps, id)

test('reasoning-only whole-review exhaustion automatically checks three dimensions with the complete work and constraints', async () => {
  const f = fixture(), calls: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    f.assertComplete(prompt)
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    return emptyResult(contract)
  }, { context: f.context, steps: f.steps() })
  assert.deepEqual(calls, ['whole', ...dimensions])
  const checkpoint = f.store().checkpoint
  assert.equal(checkpoint.steps['review:coordinates:v1:review:recovery']!.value, 'dimensions')
  for (const scope of dimensions) assert.ok(has(checkpoint, `review:coordinates:v1:review:dimension:${scope}`))
  assert.deepEqual((checkpoint.steps['review:coordinates:v1:review:whole']!.value as ReturnType<typeof clear>).findings, [])
  await reviewScriptDraftCompleteness(f.draft, async () => assert.fail('completed validated dimensions must be durable'),
    { context: f.context, steps: f.steps() })
})

test('each focused dimension enforces complete artifact coverage and current coordinates before durable acceptance', async t => {
  for (const target of dimensions) for (const invalid of ['coverage', 'coordinates']) await t.test(`${target} ${invalid}`, async () => {
    const f = fixture(), calls: string[] = []
    const invalidResult = (prompt: string) => {
      if (invalid === 'coverage') return resultText({ ...clear(), checked_artifacts: expected.slice(1) })
      const source = draftReviewCoordinateMaterial(prompt)[0]!
      return JSON.stringify({ ...clear(), findings: [{ source_key: source.key, source_ref: source.source_ref,
        first_unit: 999999, last_unit: 999999, kind: 'contradiction', severity: 'blocking',
        explanation: '必须保留的实质问题。', suggestion: '落实原稿约束。' }] })
    }
    const checkInvalid = (issue: unknown) => {
      assert.equal((issue as { structuredOutputContract?: string }).structuredOutputContract, 'script_draft_completeness_coordinates')
      assert.match((issue as Error).message, invalid === 'coverage' ? /全部文档类型/ : /坐标|证据|分段/)
      return true
    }
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      f.assertComplete(prompt)
      const scope = dimension(prompt); calls.push(scope)
      if (scope === 'whole') throw exhausted()
      return scope === target ? invalidResult(prompt) : emptyResult(contract)
    }, { context: f.context, steps: f.steps() }), checkInvalid)
    assert.equal(calls.filter(scope => scope === target).length, 2, 'one invalid result receives exactly one contract correction')
    const checkpoint = f.store().checkpoint
    assert.equal(has(checkpoint, `review:coordinates:v1:review:dimension:${target}`), false)
    assert.equal(has(checkpoint, 'review:coordinates:v1:review:whole'), false, 'a failed dimension cannot produce overall success')
    const before = calls.length
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => {
      calls.push('unexpected'); assert.fail('persisted invalid correction must not purchase a new author decision')
    }, { context: f.context, steps: f.steps() }), checkInvalid)
    assert.equal(calls.length, before, 'the same failed correction is revalidated from saved raw without dispatch')

    // A valid correction in the original attempt can be adopted, with every
    // semantic field preserved and evidence hydrated from the current units.
    const g = fixture(), repaired = finding(g.draft, 0, '当前候选与原稿存在实质矛盾。')
    let targetCalls = 0
    const repair = () => reviewScriptDraftCompleteness(g.draft, async (prompt, contract) => {
      const scope = dimension(prompt)
      if (scope === 'whole') throw exhausted()
      if (scope !== target) return emptyResult(contract)
      if (++targetCalls === 1) return invalidResult(prompt)
      return resultText({ ...clear(), findings: invalid === 'coverage' ? [] : [repaired] })
    }, { context: g.context, steps: g.steps() })
    if (invalid === 'coverage') await repair()
    else await assert.rejects(repair(), issue => {
      assert.ok(issue instanceof ScriptDraftNeedsResolution)
      assert.equal(issue.findings.length, 1)
      assert.equal(issue.findings[0]!.source_key, repaired.source_key)
      assert.equal(issue.findings[0]!.quote, repaired.quote)
      assert.equal(issue.findings[0]!.explanation, repaired.explanation)
      assert.equal(issue.findings[0]!.suggestion, repaired.suggestion)
      return true
    })
    assert.equal(targetCalls, 2)
    assert.ok(has(g.store().checkpoint, `review:coordinates:v1:review:dimension:${target}`))
    assert.ok(has(g.store().checkpoint, 'review:coordinates:v1:review:whole'))
  })
})

test('another output limit stops focused recovery and a persisted continuation runs only unfinished dimensions', async () => {
  const f = fixture(), calls: string[] = [], failure = exhausted()
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    if (scope === 'consistency') throw failure
    return emptyResult(contract)
  }, { context: f.context, steps: f.steps() }), issue => issue instanceof ReviewPaginationStalledError && issue.cause === failure)
  assert.deepEqual(calls, ['whole', 'settings', 'consistency', ...Array(4).fill('consistency')])
  const saved = f.store().checkpoint
  assert.equal(has(saved, 'review:coordinates:v1:review:dimension:settings'), true)
  assert.equal(has(saved, 'review:coordinates:v1:review:dimension:consistency'), false)
  assert.equal(has(saved, 'review:coordinates:v1:review:whole'), false)
  const resumed: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => { resumed.push(dimension(prompt)); return emptyResult(contract) },
    { context: f.context, steps: f.steps() })
  assert.deepEqual(resumed, ['consistency', 'requirements'])
})

test('persisted usage retains an accepted request and unknown delivery cannot dispatch again on continuation', async () => {
  const f = fixture(), previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
  const dispatched: string[] = [], interrupted = new TextProviderError('network interrupted', false, 'connection_error')
  let failConsistency = true
  try {
    process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '2'
    const budget = sourceProposalBudget(f.projectId, scriptProposalBudgetScope(f.draft))
    const generator = async (prompt: string, contract?: OutputContract) => {
      const scope = dimension(prompt)
      const request = beginTextRequest({ request_bytes: Buffer.byteLength(prompt), estimated_input_tokens: 66_000, reserved_output_tokens: 65_535 })
      dispatched.push(scope)
      request.complete({ input_tokens: 66_000, output_tokens: scope === 'whole' ? 65_535 : 30, reasoning_tokens: scope === 'whole' ? 65_535 : 0 })
      if (scope === 'whole') throw exhausted()
      if (scope === 'consistency' && failConsistency) throw interrupted
      return emptyResult(contract)
    }
    await assert.rejects(budget.run(() => reviewScriptDraftCompleteness(f.draft, generator,
      { context: f.context, steps: f.steps() })), issue => issue === interrupted)
    assert.deepEqual(dispatched, ['whole', 'settings', 'consistency'])
    assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:whole'), false)
    const settings = f.store().checkpoint.steps['review:coordinates:v1:review:dimension:settings']
    const unchanged = sourceProposalBudget(f.projectId, scriptProposalBudgetScope(f.draft))
    assert.equal(unchanged.usage.requests, 3)
    failConsistency = false
    await assert.rejects(unchanged.run(() => reviewScriptDraftCompleteness(f.draft, generator,
      { context: f.context, steps: f.steps() })), issue => {
      assert.equal((issue as { code?: string }).code, 'structured_initial_delivery_pending'); return true
    })
    assert.deepEqual(dispatched, ['whole', 'settings', 'consistency'], 'accepted unknown delivery must not be submitted twice')
    assert.equal(unchanged.usage.requests, 3, 'previous billable usage remains cumulative even though continuation dispatches nothing')
    assert.deepEqual(f.store().checkpoint.steps['review:coordinates:v1:review:dimension:settings'], settings)
    assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:whole'), false)
  } finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = previous
  }
})

test('cancellation preserves completed dimensions and prevents all further model dispatch until explicit continuation', async () => {
  const f = fixture(), controller = new AbortController(), reason = Object.assign(new Error('创作者在发送前停止核对'), { delivery: 'not_sent' as const }), calls: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    if (scope === 'consistency') { controller.abort(reason); throw reason }
    return emptyResult(contract)
  }, { context: f.context, signal: controller.signal, steps: f.steps(controller.signal) }), issue => issue === reason)
  assert.deepEqual(calls, ['whole', 'settings', 'consistency'])
  assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:dimension:settings'), true)
  assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:whole'), false)
  const resumed: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => { resumed.push(dimension(prompt)); return emptyResult(contract) },
    { context: f.context, steps: f.steps() })
  assert.deepEqual(resumed, ['consistency', 'requirements'])
})

test('even valid JSON carried as truncated partial text never substitutes for a completed review', async () => {
  const f = fixture(), calls: string[] = [], failure = exhausted(resultText())
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted(resultText())
    if (scope === 'consistency') throw failure
    return emptyResult(contract)
  }, { context: f.context, steps: f.steps() }), issue => issue instanceof ReviewPaginationStalledError && issue.cause === failure)
  assert.deepEqual(calls, ['whole', 'settings', 'consistency', ...Array(4).fill('consistency')])
  assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:whole'), false)
  assert.equal(has(f.store().checkpoint, 'review:coordinates:v1:review:dimension:consistency'), false)
})

test('a changed manuscript, creator constraint or candidate invalidates the former recovery and all dimension results', async t => {
  for (const changed of ['source', 'creator', 'candidate']) await t.test(changed, async () => {
    const f = fixture()
    await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      const scope = dimension(prompt)
      if (scope === 'whole' || scope === 'consistency') throw exhausted()
      return emptyResult(contract)
    }, { context: f.context, steps: f.steps() }), ReviewPaginationStalledError)
    if (changed === 'source') f.context.uploaded_script.content += '\n当前有效稿新增的重要因果。'
    if (changed === 'creator') f.context.creator_messages[1]!.text += '再保留主角已知真相的条件。'
    if (changed === 'candidate') f.draft.artifacts[8]!.content += '\n最后一份文档的真实修改。'
    const calls: string[] = []
    await reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
      const scope = dimension(prompt); calls.push(scope); f.assertComplete(prompt)
      if (scope === 'whole') throw exhausted()
      return emptyResult(contract)
    }, { context: f.context, steps: f.steps() })
    assert.deepEqual(calls, ['whole', ...dimensions])
  })
})

test('a corrupt canonical dimension recovers its real finding from exact raw instead of trusting an older empty aggregate', async () => {
  const f = fixture(), actual = finding(f.draft, 0, '当前正文与原稿人物身份矛盾。')
  const check = (issue: unknown) => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 1)
    assert.equal(issue.findings[0]!.explanation, actual.explanation)
    assert.equal(issue.findings[0]!.quote, actual.quote)
    return true
  }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    const scope = dimension(prompt)
    if (scope === 'whole') throw exhausted()
    return scope === 'settings' ? resultText({ ...clear(), findings: [actual] }) : emptyResult(contract)
  }, { context: f.context, steps: f.steps() }), check)
  const store = f.store(), saved = store.checkpoint
  saved.steps['review:coordinates:v1:review:dimension:settings']!.value = {
    ...clear(), findings: [{ ...actual, quote: '缓存里伪造的不存在引文' }],
  }
  saved.steps['review:coordinates:v1:review:whole']!.value = clear()
  store.save(saved)
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => {
    calls++; assert.fail('the exact retained raw response recovers the original finding locally')
  }, { context: f.context, steps: f.steps() }), check)
  assert.equal(calls, 0)
  assert.equal((f.store().checkpoint.steps['review:coordinates:v1:review:whole']!.value as { findings: unknown[] }).findings.length, 1)
})

test('all distinct cross-dimension findings survive aggregation and still block completion after durable replay', async () => {
  const f = fixture(), findings = Array.from({ length: 6 }, (_, index) => finding(f.draft, index)), calls: string[] = []
  const check = (issue: unknown) => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, findings.length)
    assert.deepEqual(issue.findings.map(item => item.explanation), findings.map(item => item.explanation))
    assert.deepEqual(issue.findings.map(item => item.quote), findings.map(item => item.quote))
    return true
  }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    f.assertComplete(prompt)
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    const index = dimensions.indexOf(scope as typeof dimensions[number])
    const own = findings.slice(index * 2, index * 2 + 2)
    return resultText({ ...clear(), findings: index === 1 ? [findings[0]!, ...own] : own })
  }, { context: f.context, steps: f.steps() }), check)
  assert.deepEqual(calls, ['whole', ...dimensions])
  assert.equal((f.store().checkpoint.steps['review:coordinates:v1:review:whole']!.value as ReturnType<typeof clear> & { findings: unknown[] }).findings.length, 6)
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => assert.fail('cached real findings must block without another model request'),
    { context: f.context, steps: f.steps() }), check)
})

test('three hundred cross-dimension reports can become one hundred real issues without losing any evidence', async () => {
  const f = fixture(), calls: string[] = []
  const check = (issue: unknown) => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 100, 'the final issue limit applies after grouping all dimension reports')
    for (const [index, item] of issue.findings.entries()) {
      assert.equal(item.topic, `第${index}项跨文档资源条件`)
      const evidence = [item, ...(item.related_findings || [])]
      assert.equal(evidence.length, 3, 'all three independent locations and explanations survive grouping')
      assert.deepEqual(new Set(evidence.map(report => report.explanation)),
        new Set(dimensions.map(scope => `${scope}发现第${index}项资源条件仍有缺口。`)))
      assert.equal(new Set(evidence.map(report => report.source_key)).size, 3)
    }
    return true
  }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (prompt.includes('归并本阶段独立复核发现的共同事项')) {
      calls.push('groups')
      const marker = '本轮问题：'
      const reports = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as Array<{ index: number; topic: string }>
      assert.equal(reports.length, 300, 'semantic grouping receives every report, including those beyond two hundred')
      const groups = new Map<string, number[]>()
      for (const report of reports) groups.set(report.topic, [...(groups.get(report.topic) || []), report.index])
      assert.equal(groups.size, 100)
      for (const members of groups.values()) assert.equal(members.length, 3)
      return draftReviewFixtureJson({ groups: [...groups].map(([topic, members]) => ({ topic, members })) })
    }
    f.assertComplete(prompt)
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    const dimensionIndex = dimensions.indexOf(scope as typeof dimensions[number])
    return resultText({ ...clear(), findings: Array.from({ length: 100 }, (_, index) => ({
      ...finding(f.draft, index + dimensionIndex, `${scope}发现第${index}项资源条件仍有缺口。`),
      topic: `第${index}项跨文档资源条件`,
    })) })
  }, { context: f.context, steps: f.steps() }), check)
  assert.deepEqual(calls, ['whole', ...dimensions, 'groups'])
  assert.equal((f.store().checkpoint.steps['review:coordinates:v1:review:whole']!.value as { findings: unknown[] }).findings.length, 300,
    'the aggregate checkpoint preserves the complete ungrouped reports')
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => assert.fail('validated aggregate and grouping must survive continuation'),
    { context: f.context, steps: f.steps() }), check)
})

test('more than two hundred final independent issues stop completion without truncating saved reports or rerunning review', async () => {
  const f = fixture(), calls: string[] = []
  const check = (issue: unknown) => {
    assert.ok(issue instanceof Error)
    assert.equal(issue instanceof ScriptDraftNeedsResolution, false, 'an oversized issue list cannot be handed off as a clipped repair list')
    assert.match(issue.message, /超过 200 项独立问题/)
    assert.match(issue.message, /已保留全部核查结果/)
    assert.match(issue.message, /未截断或忽略问题/)
    return true
  }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    if (prompt.includes('归并本阶段独立复核发现的共同事项')) {
      calls.push('groups')
      const marker = '本轮问题：'
      const reports = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as Array<{ index: number; topic: string }>
      assert.equal(reports.length, 210)
      return draftReviewFixtureJson({ groups: reports.map(({ index, topic }) => ({ topic, members: [index] })) })
    }
    const scope = dimension(prompt); calls.push(scope)
    if (scope === 'whole') throw exhausted()
    const offset = dimensions.indexOf(scope as typeof dimensions[number]) * 70
    return resultText({ ...clear(), findings: Array.from({ length: 70 }, (_, index) => ({
      ...finding(f.draft, offset + index), topic: `第${offset + index}项独立因果缺口`,
    })) })
  }, { context: f.context, steps: f.steps() }), check)
  assert.deepEqual(calls, ['whole', ...dimensions, 'groups'])
  const checkpoint = f.store().checkpoint
  const savedReports = (checkpoint.steps['review:coordinates:v1:review:whole']!.value as { findings: Array<{ topic: string }> }).findings
  assert.equal(savedReports.length, 210)
  assert.equal(new Set(savedReports.map(report => report.topic)).size, 210)
  assert.equal((checkpoint.steps['review:issue-groups']!.value as { groups: unknown[] }).groups.length, 210)
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async () => assert.fail('oversized final results remain complete and review is not replayed'),
    { context: f.context, steps: f.steps() }), check)
})


test('persisted review usage is cumulative across a true pre-dispatch pause without enforcing the former request limit', async () => {
  const f = fixture(), previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
  const dispatched: string[] = [], pause = Object.assign(new Error('fixture paused before provider dispatch'), { delivery: 'not_sent' as const })
  let paused = true
  try {
    process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '2'
    const generator = async (prompt: string, contract?: OutputContract) => {
      const scope = dimension(prompt)
      if (scope === 'consistency' && paused) throw pause
      const request = beginTextRequest({ request_bytes: Buffer.byteLength(prompt), estimated_input_tokens: 66_000, reserved_output_tokens: 65_535 })
      dispatched.push(scope)
      request.complete({ input_tokens: 66_000, output_tokens: scope === 'whole' ? 65_535 : 30, reasoning_tokens: scope === 'whole' ? 65_535 : 0 })
      if (scope === 'whole') throw exhausted()
      return emptyResult(contract)
    }
    const first = sourceProposalBudget(f.projectId, scriptProposalBudgetScope(f.draft))
    await assert.rejects(first.run(() => reviewScriptDraftCompleteness(f.draft, generator,
      { context: f.context, steps: f.steps() })), issue => issue === pause)
    assert.deepEqual(dispatched, ['whole', 'settings'])
    const settings = f.store().checkpoint.steps['review:coordinates:v1:review:dimension:settings']
    const resumed = sourceProposalBudget(f.projectId, scriptProposalBudgetScope(f.draft))
    assert.equal(resumed.usage.requests, 2)
    paused = false
    await resumed.run(() => reviewScriptDraftCompleteness(f.draft, generator, { context: f.context, steps: f.steps() }))
    assert.deepEqual(dispatched, ['whole', 'settings', 'consistency', 'requirements'])
    assert.equal(resumed.usage.requests, 4)
    assert.deepEqual(f.store().checkpoint.steps['review:coordinates:v1:review:dimension:settings'], settings)
    assert.ok(f.store().checkpoint.steps['review:coordinates:v1:review:whole'])
  } finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = previous
  }
})
