import { draftReviewFixtureJson } from './fixtures/script-draft-completeness.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution } from '../src/modules/script/script-draft-completeness.js'
import { draftReviewTaskContext, planDraftReviewTasks } from '../src/modules/script/script-draft-review-plan.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'
import type { WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'

type Source = { key: string; artifact_type: string; title: string; content: string }
const sourceMarker = '待核对草稿原文（资料）：'
function submitted(prompt: string): Source[] { return JSON.parse(prompt.slice(prompt.lastIndexOf(sourceMarker) + sourceMarker.length).split('\n【本轮候选正文结束】')[0]!) }
function phase(prompt: string) {
  if (prompt.includes('【独立任务：全局一致性】')) return 'consistency'
  const keys = submitted(prompt).map(source => source.key)
  return keys.includes('world') && !keys.includes('outline') ? 'world' : keys.includes('hooks') && !keys.includes('outline') ? 'payoffs' : 'story'
}
function clear(prompt: string) { return { checked_artifacts: [...new Set(submitted(prompt).map(source => source.artifact_type))], findings: [] } }
function fixture(large = true) {
  const draft: WorkflowDraft = { stage: 'outline', scope: 'project', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.outline.map((artifact_type, index) => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `独有文档${index}。林晚寻找失踪家人。${large ? `完整设定${index}，`.repeat(400) : ''}最后归还铜钥匙。` })) }
  const context = { uploaded_script: { content: '完整原稿：林晚寻找失踪家人，最后归还铜钥匙。结尾的关键事实。' },
    creator_messages: [{ role: 'user', text: '完成已要求的设计，不改变原稿结局。' }],
    resolved_findings: { decisions: [] as Array<{ source_key: string; decision: string; summary_id: string }>, summaries: [] as Array<{ id: string; text: string }> } }
  let checkpoint: GenerationCheckpoint = { steps: {} }
  const steps = () => createGenerationSteps({ checkpoint, save: value => { checkpoint = structuredClone(value) } })
  return { draft, context, steps, checkpoint: () => checkpoint }
}

test('source-outline intent accepts a useful outline without demanding the other eight design documents', async () => {
  const f = fixture(false)
  f.draft.artifacts = [f.draft.artifacts[0]!]
  ;(f.draft as WorkflowDraft & { intent?: string }).intent = 'source_outline'
  let calls = 0
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls++
    assert.match(prompt, /允许如实保留原稿未知事项，不创造答案/)
    assert.match(prompt, /不能要求未交付文档或下阶段栏目/)
    assert.doesNotMatch(prompt, /创作资料应明确真实答案/)
    assert.deepEqual(submitted(prompt).map(source => source.key), ['outline'])
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, review_scope: 'adaptive' })
  assert.equal(calls, 1)
})

test('style and optional deepening remain suggestions while genuine and legacy blocking evidence still stop the draft', async () => {
  const f = fixture(false), source = f.draft.artifacts[0]!, seen: string[] = []
  const common = { source_key: 'outline', kind: 'contradiction', quote: source.content, suggestion: '保留原稿结局。' }
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => draftReviewFixtureJson({ ...clear(prompt), findings: [
    { ...common, severity: 'suggestion', explanation: '可增加更细的动作描写。' },
    { ...common, severity: 'blocking', explanation: '原稿归还钥匙，候选却写成销毁，改变了明确结局。' },
    { ...common, explanation: '人物先知情后首次得知，同一时序矛盾。' },
  ] }), { onSuggestions: findings => seen.push(...findings.map(finding => finding.explanation)) }), issue => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 2)
    assert.ok(issue.findings.every(finding => !('severity' in finding)), 'wire-only severity does not leak into the shared repair schema')
    return true
  })
  assert.deepEqual(seen, ['可增加更细的动作描写。'])
  await reviewScriptDraftCompleteness(f.draft, async prompt => draftReviewFixtureJson({ ...clear(prompt), findings: [
    { ...common, severity: 'suggestion', explanation: '可增加更细的动作描写。' },
  ] }))
})

test('a suggestion cannot bypass candidate-source and verbatim-evidence validation', async () => {
  const f = fixture(false), calls: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async (prompt, contract) => {
    calls.push(contract!.name)
    if (contract!.name === 'script_draft_evidence_repair') return draftReviewFixtureJson({ repairs: [{ id: 'findings:0', first_unit: null, last_unit: null }] })
    if (contract!.name === 'script_draft_evidence_reassessment') return draftReviewFixtureJson({ reassessments: [{
      id: 'findings:0', verdict: 'unresolved', reason: '现有候选原文不足以确认或撤回该建议。', source_key: null, first_unit: null, last_unit: null,
    }] })
    return draftReviewFixtureJson({ ...clear(prompt), findings: [{ source_key: 'outline', kind: 'missing_core_setting', severity: 'suggestion',
      quote: '候选没有这句话。', explanation: '可以深化。', suggestion: '丰富细节。' }] })
  }), /证据/)
  assert.deepEqual(calls, ['script_draft_completeness', 'script_draft_evidence_repair', 'script_draft_evidence_reassessment'])
})

test('adaptive review keeps a small complete task to one request instead of multiplying reviews', async () => {
  const f = fixture(false), calls: Source[][] = []
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls.push(submitted(prompt)); return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, review_scope: 'adaptive' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.length, 9)
})

test('large work is checked in complete logical groups followed by a mandatory full-work consistency task', async () => {
  const f = fixture(), calls: string[] = []
  const plan = planDraftReviewTasks(f.draft.stage, f.draft.artifacts.map(artifact => ({ key: artifact.artifact_type, ...artifact })), 'adaptive')
  assert.deepEqual(plan.map(task => task.id), ['story', 'world', 'payoffs', 'consistency'])
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    const kind = phase(prompt), sources = submitted(prompt); calls.push(kind)
    assert.ok(prompt.includes(f.context.uploaded_script.content), 'the full original is available to every task')
    for (const source of sources) assert.equal(source.content, f.draft.artifacts.find(artifact => artifact.artifact_type === source.key)!.content)
    if (kind === 'consistency') assert.equal(sources.length, 9, 'global comparison receives every complete candidate')
    else {
      assert.match(prompt, /缺少未送审文档不是问题/)
      assert.ok(sources.length < 9)
      for (const artifact of f.draft.artifacts.filter(artifact => !sources.some(source => source.key === artifact.artifact_type))) {
        assert.ok(!prompt.includes(artifact.content), 'unrelated candidates do not invalidate a local review input')
      }
    }
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
})

test('a local edit reuses unaffected successful groups and still reruns the full cross-document check', async () => {
  const f = fixture(), calls: string[] = []
  const generate = async (prompt: string) => { calls.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt)) }
  const run = () => reviewScriptDraftCompleteness(f.draft, generate, { context: f.context, steps: f.steps(), review_scope: 'adaptive', changed_sources: ['world'] })
  await run()
  calls.length = 0
  f.draft.artifacts.find(artifact => artifact.artifact_type === 'world')!.content += '\n铜钥匙只能在夜间打开旧门。'
  await run()
  assert.deepEqual(calls, ['world', 'consistency'])
  calls.length = 0
  await run()
  assert.deepEqual(calls, [], 'all exact successful tasks are durable')
})

test('a failed final check resumes only that task and cannot silently pass on successful local tasks', async () => {
  const f = fixture(), calls: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const kind = phase(prompt); calls.push(kind)
    if (kind === 'consistency') throw new Error('全文核对连接中断')
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' }), /连接中断/)
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
  assert.ok(!f.checkpoint().steps['review:task:consistency:result'])
  calls.length = 0
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.deepEqual(calls, ['consistency'])
})

test('a real cross-document conflict blocks after local success and remains blocking when replayed from checkpoints', async () => {
  const f = fixture(), calls: string[] = []
  const run = (generate: Parameters<typeof reviewScriptDraftCompleteness>[1]) => reviewScriptDraftCompleteness(f.draft, generate,
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  const check = (issue: unknown) => {
    assert.ok(issue instanceof ScriptDraftNeedsResolution)
    assert.equal(issue.findings.length, 1)
    assert.match(issue.findings[0]!.explanation, /归还与销毁冲突/)
    return true
  }
  await assert.rejects(run(async prompt => {
    const kind = phase(prompt); calls.push(kind)
    return draftReviewFixtureJson({ ...clear(prompt), findings: kind === 'consistency' ? [{ source_key: 'outline', kind: 'contradiction', severity: 'blocking',
      quote: '最后归还铜钥匙。', explanation: '概要与分集结局的归还与销毁冲突，导致道具终态不一致。', suggestion: '按原稿统一为归还。' }] : [] })
  }), check)
  await assert.rejects(run(async () => assert.fail('validated blocking findings must replay without another model call')), check)
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
})

test('a changed original or creator requirement invalidates every dependent logical task', async () => {
  const f = fixture(), calls: string[] = []
  const run = () => reviewScriptDraftCompleteness(f.draft, async prompt => { calls.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt)) },
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  await run()
  calls.length = 0
  f.context.uploaded_script.content += '补充：钥匙归还给姐姐。'
  await run()
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
  calls.length = 0
  f.context.creator_messages[0]!.text += '保留姐姐身份。'
  await run()
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
})

test('task-specific history keeps the complete reference chain for option-based creator answers', () => {
  const f = fixture(false), story = { key: 'outline', ...f.draft.artifacts[0]! }
  f.context.resolved_findings.decisions.push({ source_key: 'outline', decision: '采用方案二，同上。', summary_id: 'story' },
    { source_key: 'world', decision: '铜钥匙的具体条件。', summary_id: 'world' })
  f.context.resolved_findings.summaries.push({ id: 'story', text: '候选方案。' }, { id: 'world', text: '关联的前述方案。' })
  assert.equal(draftReviewTaskContext(f.context, [story]), f.context)
})

test('scoped output-limit recovery keeps successful sibling tasks and resumes only unfinished review dimensions (serial mode)', async t => {
  process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY = '1'; t.after(() => { delete process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY })
  const f = fixture(), calls: string[] = []
  const dimension = (prompt: string) => /本轮核查维度：([a-z]+)。/.exec(prompt)?.[1] || 'whole'
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const task = phase(prompt), mode = dimension(prompt); calls.push(`${task}:${mode}`)
    assert.ok(prompt.includes(f.context.uploaded_script.content))
    if (task === 'world' && mode === 'whole') throw new TextOutputLimitError('', 'length')
    if (task === 'world' && mode === 'consistency') throw new Error('当前维度连接中断')
    if (task === 'world') assert.match(prompt, /只能缩小下方固定任务合同/)
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' }), /当前维度连接中断/)
  assert.deepEqual(calls, ['story:whole', 'world:whole', 'world:settings', 'world:consistency'])
  calls.length = 0
  await reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls.push(`${phase(prompt)}:${dimension(prompt)}`); return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.deepEqual(calls, ['world:consistency', 'world:requirements', 'payoffs:whole', 'consistency:whole'])
})

test('cancellation never dispatches remaining tasks and continuation reuses the completed task (serial mode)', async t => {
  process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY = '1'; t.after(() => { delete process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY })
  const f = fixture(), controller = new AbortController(), calls: string[] = [], reason = new Error('创作者停止任务')
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const task = phase(prompt); calls.push(task)
    if (task === 'world') { controller.abort(reason); throw reason }
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), signal: controller.signal, review_scope: 'adaptive' }), issue => issue === reason)
  assert.deepEqual(calls, ['story', 'world'])
  calls.length = 0
  await reviewScriptDraftCompleteness(f.draft, async prompt => { calls.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt)) },
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.deepEqual(calls, ['world', 'payoffs', 'consistency'])
})

function concurrencyProbe() {
  let inflight = 0, max = 0; const events: string[] = []
  return {
    events, get max() { return max },
    async run(task: string, work: () => Promise<string>) {
      events.push(`start:${task}`); inflight++; max = Math.max(max, inflight)
      try { await new Promise(resolve => setTimeout(resolve, 15)); return await work() } finally { inflight--; events.push(`end:${task}`) }
    },
  }
}

test('independent local groups overlap within the configured ceiling and the global check always runs last', async t => {
  const f = fixture(), probe = concurrencyProbe()
  await reviewScriptDraftCompleteness(f.draft, prompt => probe.run(phase(prompt), async () => draftReviewFixtureJson(clear(prompt))),
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.ok(probe.max >= 2 && probe.max <= 3, `groups overlapped without exceeding the default ceiling (saw ${probe.max})`)
  const globalStart = probe.events.indexOf('start:consistency')
  for (const group of ['story', 'world', 'payoffs']) assert.ok(probe.events.indexOf(`end:${group}`) < globalStart, `${group} finished before the global consistency check started`)
  assert.equal(probe.events.filter(event => event === 'start:consistency').length, 1)

  process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY = '2'; t.after(() => { delete process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY })
  const capped = concurrencyProbe(), g = fixture()
  await reviewScriptDraftCompleteness(g.draft, prompt => capped.run(phase(prompt), async () => draftReviewFixtureJson(clear(prompt))),
    { context: g.context, steps: g.steps(), review_scope: 'adaptive' })
  assert.equal(capped.max, 2, 'a lower ceiling is respected')
})

test('a failed group keeps its finished siblings and only the failed group plus the global check run again', async () => {
  const f = fixture(), first: string[] = []
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const task = phase(prompt); first.push(task)
    if (task === 'world') throw new Error('世界观检查连接中断')
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' }), /世界观检查连接中断/)
  assert.ok(first.includes('story') && first.includes('payoffs'), 'siblings were not abandoned by the failure')
  assert.ok(!first.includes('consistency'), 'the global check never runs on incomplete local results')
  const second: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async prompt => { second.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt)) },
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  assert.deepEqual([...new Set(second)].sort(), ['consistency', 'world'], 'completed groups are reused; no group is dispatched twice')
  assert.equal(second.at(-1), 'consistency')
})

test('after cancellation no further group is dispatched, even while a sibling is still running', async t => {
  process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY = '2'; t.after(() => { delete process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY })
  const f = fixture(), controller = new AbortController(), calls: string[] = [], reason = new Error('创作者停止任务')
  let aborted!: () => void; const abortedSignal = new Promise<void>(resolve => { aborted = resolve })
  await assert.rejects(reviewScriptDraftCompleteness(f.draft, async prompt => {
    const task = phase(prompt); calls.push(task)
    if (task === 'world') { controller.abort(reason); aborted(); throw reason }
    await abortedSignal // story is still running when the abort happens
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), signal: controller.signal, review_scope: 'adaptive' }), issue => issue === reason)
  assert.deepEqual([...calls].sort(), ['story', 'world'], 'the third group and the global check were never started')
  const resumed: string[] = []
  await reviewScriptDraftCompleteness(f.draft, async prompt => { resumed.push(phase(prompt)); return draftReviewFixtureJson(clear(prompt)) },
    { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  // A result that finishes after cancellation is never checkpointed, so the group that was in flight is redone.
  assert.deepEqual([...new Set(resumed)].sort(), ['consistency', 'payoffs', 'story', 'world'])
  assert.equal(resumed.at(-1), 'consistency')
})


test('cross-document history is retained for arbitrary creator references and invalidates dependent reviews', async () => {
  const f = fixture(), calls: string[] = []
  const run = () => reviewScriptDraftCompleteness(f.draft, async prompt => {
    calls.push(phase(prompt))
    for (const decision of f.context.resolved_findings.decisions) assert.ok(prompt.includes(decision.decision))
    return draftReviewFixtureJson(clear(prompt))
  }, { context: f.context, steps: f.steps(), review_scope: 'adaptive' })
  await run()
  calls.length = 0
  f.context.resolved_findings.decisions.push({ source_key: 'world', decision: '照刚才讲的办', summary_id: 'cross-document' })
  f.context.resolved_findings.summaries.push({ id: 'cross-document', text: '该答复依赖概要文档中的旧问答。' })
  const sources = [{ key: 'outline', ...f.draft.artifacts[0]! }]
  assert.equal(draftReviewTaskContext(f.context, sources), f.context)
  await run()
  assert.deepEqual(calls, ['story', 'world', 'payoffs', 'consistency'])
  calls.length = 0
  await run()
  assert.deepEqual(calls, [], 'unchanged complete evidence still reuses successful checkpoints')
})
